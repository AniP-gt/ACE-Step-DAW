1. Root cause

**`connectBridge.poll`が、既存jobの実行をnative request処理の成功に依存させています。**

[src/services/logicBridge.ts:105](/Users/takuya/workspace/github.com/AniP-gt/ACE-Step-DAW/src/services/logicBridge.ts:105)の`await processNativeRequests(...)`が失敗すると、107行目のjobs取得と122行目の`runBridgeJob`を飛ばし、127行目のcatchへ移ります。

この失敗は次の状態遷移で確実に起こります。

- [nativeRequests.ts:69](/Users/takuya/workspace/github.com/AniP-gt/ACE-Step-DAW/server/logic-bridge/nativeRequests.ts:69)：受付時には既存jobの占有だけを確認するため、job作成前なら両ownerのintentを受理できます。
- [nativeRequests.ts:101](/Users/takuya/workspace/github.com/AniP-gt/ACE-Step-DAW/server/logic-bridge/nativeRequests.ts:101)：最初の`/submit`がjob Aを作ります。
- [jobs.ts:43](/Users/takuya/workspace/github.com/AniP-gt/ACE-Step-DAW/server/logic-bridge/jobs.ts:43)：job Aは`queued/reserved`なので、次のsubmitは`PROJECT_BUSY`になります。
- [logicBridgeNativeRequests.ts:93](/Users/takuya/workspace/github.com/AniP-gt/ACE-Step-DAW/src/services/logicBridgeNativeRequests.ts:93)：このエラーは伝播し、次のpollでも同じpending intentがjob Aの実行を妨げます。

現行poll本体とサーバー関数をメモリ上で再実行し、以下を確認しました。

```text
現行・2 polls:
errors=[PROJECT_BUSY, PROJECT_BUSY]
submitAttempts=3, jobPolls=0, dispatches=0
intents=[submitted, pending], job A=queued/reserved

順序変更案・3 polls:
errors=[PROJECT_BUSY]
jobPolls=3, dispatches=2, failCalls=0
intents=[submitted, submitted]
```

音声生成・transport・storeはスタブです。実機での生成成功を示す結果ではありません。

2. Other candidates ruled out

- **ownerやbindingの衝突**：`latestPrepare`はowner hash単位です（`server/logic-bridge/nativeRequests.ts:31`）。異なるowner・capture・bindingを用い、両intentの受付と最初のsubmitが成功しました。
- **モデルやsource検証の失敗**：サーバー検証を通った後、2件目は占有判定で`PROJECT_BUSY`になります。再実行でも`STALE_BINDING`や`LEGO_UNAVAILABLE`ではありません。
- **推論処理の停止**：`runBridgeJob`への到達回数自体が0です。
- **M3のエラー伝播が不要**：503・応答喪失ではsubmit済みの可能性があり、伝播と状態保持は必要です。修正対象はその伝播をjob実行より先に置いている呼び出し順序です。

3. Smallest fix

既存jobの取得・reconciliation・実行を先に行います。新規submitでできたjobは次のpollで処理します。`PROJECT_BUSY`のエラー表示は残りますが、以降のjob処理を永久に妨げなくなります。

`runBridgeJob`、submit失敗時の扱い、各await後のguard、credential epochは変更しません。処理は引き続き直列です。

```diff
--- a/src/services/logicBridge.ts
+++ b/src/services/logicBridge.ts
@@ -102,8 +102,6 @@
       }
       await refreshBridge();
       guard();
-      await processNativeRequests({ token, sessionId, projectId: project.id, guard });
-      guard();
       const response = await bridgeJson(token, `/executor/jobs?sessionId=${encodeURIComponent(sessionId)}`);
       guard();
       const jobs = objects(response, 'jobs');
@@ -122,6 +120,8 @@
         if (active && job.state === 'queued') await runBridgeJob(job, controller.signal);
       }
       guard();
+      await processNativeRequests({ token, sessionId, projectId: project.id, guard });
+      guard();
       await refreshBridge();
       guard();
     } catch (error) {
```

差分は適用していません。

4. How to verify

以下は現在のpoll本体を読み込み、native処理が失敗しても既存queued jobが実行され、エラーも保持されることを確認する読み取り専用コマンドです。

```bash
node --input-type=module -e '
import fs from "node:fs";
import ts from "typescript";
import assert from "node:assert/strict";
const text=fs.readFileSync("src/services/logicBridge.ts","utf8");
const poll=text.slice(text.indexOf("  const poll = async () => {"),text.indexOf("  void poll();"));
const js=ts.transpileModule(poll.replaceAll("import.meta.env","({})"),{
  compilerOptions:{target:ts.ScriptTarget.ES2022}
}).outputText;
let dispatches=0,error;
const noop=()=>{};
const d={
  guard:noop,refreshBridge:async()=>{},registered:JSON.stringify(["",false]),
  useModelStore:{getState:()=>({availableModels:[]})},
  useGenerationStore:{getState:()=>({backendOccupancyJobId:null})},
  useLogicBridgeStore:{setState:x=>{if(x.error)error=x.error}},
  useProjectStore:{getState:()=>({project:{id:"p"}})},
  processNativeRequests:async()=>{throw Error("PROJECT_BUSY")},
  bridgeJson:async()=>({jobs:[{jobId:"existing",state:"queued"}]}),
  objects:(x,k)=>x[k],runBridgeJob:async()=>{dispatches++},
  reconcileBridgeJob:async()=>{},project:{id:"p"},sessionId:"s",
  token:"synthetic",executorId:"e",active:true,controller:new AbortController(),
  connectionEpoch:0,epoch:0,disconnectBridge:noop,timer:undefined,setTimeout:()=>0
};
await new Function(...Object.keys(d),js+"; return poll();")(...Object.values(d));
assert.equal(dispatches,1);
assert.equal(error,"PROJECT_BUSY");
console.log("PASS: existing job dispatched; native error preserved");
'
```

現行コードでは`0 !== 1`で失敗し、提案差分をメモリ上だけに反映すると次の出力になりました。

```text
PASS: existing job dispatched; native error preserved
```

追加のpoll統合QAでは、次を合格条件にしてください。

| ケース | 合格条件 |
|---|---|
| 2 ownerのintentを事前受付 | 3 pollsで両jobを順次dispatch、`failCalls=0` |
| submit受理後の応答喪失・503 | jobを保持し、次のpollでdispatch。同じintentの再submit・failなし |
| native取得が継続して503 | 既存ordinary jobは先にdispatchし、nativeエラーを保持 |
| キャンセル | queued cancelは実行せず、実行中cancelは既存abort経路で停止 |
| await中のproject・token・executor・epoch変更 | 古い接続からのdispatch・project更新なし |
| source変更 | 既存`runBridgeJob`の再検証で推論開始を阻止 |

メモリ上の再実行では、queued cancelと接続4条件も確認しました。実行中cancel・実source検証の統合テストは今回実行していません。ファイル変更・agent CLI実行はありません。
