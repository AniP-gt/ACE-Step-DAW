#include "GenerationState.h"
#include <cassert>
#include <iostream>
using S = GenerationState;
static void ready(S& s) {
 s.pair("session"); auto p=s.beginPrepare("prep-1","capture-1",8); assert(p);
 assert(s.applyPrepare(*p, S::PrepareReceipt{"prep-1","session","project","capture-1",S::PrepareStatus::prepared,"binding-1",{}}));
 assert(s.applyReadiness(s.beginReadiness(), {"prep-1",true,{}, {"guitar","piano"}}));
}
static void prompts() {
 S s; ready(s); assert(s.canGenerate("guitar",u"")); assert(s.canGenerate("guitar",std::u16string(4096,u'a')));
 assert(!s.canGenerate("guitar",std::u16string(4097,u'a'))); std::u16string emoji;for(int i=0;i<2048;++i)emoji+=u"\U0001f3b5";
 assert(s.canGenerate("guitar",emoji));emoji+=u"\U0001f3b5";assert(!s.canGenerate("guitar",emoji));
 assert(!s.canGenerate("drums",u"x"));assert(!s.canGenerate("",u"x"));
}
static void replacement() {
 S s;ready(s);auto p=s.beginPrepare("prep-2","capture-2",12);assert(p);assert(s.snapshot().reference->captureId=="capture-1");
 assert(s.applyPrepare(*p,{"prep-2","session","project","capture-2",S::PrepareStatus::failed,{},"failed"}));
 assert(s.snapshot().reference->preparedRequestId=="prep-1" && s.snapshot().reference->durationSeconds==8);
 assert(s.canGenerate("guitar",u""));
 auto older=s.beginReadiness();auto newer=s.beginReadiness();
 assert(s.applyReadiness(newer,{"other",true,{}, {"guitar"}}));assert(!s.canGenerate("guitar",u""));
 assert(!s.applyReadiness(older,{"prep-1",true,{}, {"guitar"}}));assert(!s.canGenerate("guitar",u""));
}
static void intent() {
 S s;ready(s);auto a=s.beginGeneration("request-1","guitar",u"hello");assert(a && a->send);
 auto duplicate=s.beginGeneration("request-2","piano",u"changed");assert(duplicate && !duplicate->send && duplicate->request.requestId=="request-1");
 assert(duplicate->request.instrument=="guitar" && duplicate->request.prompt==u"hello");
 auto r=S::GenerationReceipt{"request-1","session","project","capture-1","prep-1","binding-1","guitar",u"hello",S::IntentStatus::submitted,"job-1",{}};
 assert(s.applyGeneration(a->request,r)); assert(s.snapshot().generation==S::GenerationStatus::submitted);
 assert(s.applyJob(a->request,"job-1",S::JobStatus::running,S::Occupancy::occupied,{}));
 s.cancelRequested(); assert(s.snapshot().generation==S::GenerationStatus::cancelPending);assert(!s.beginGeneration("request-2","guitar",u"x")->send);
 assert(s.applyJob(a->request,"job-1",S::JobStatus::interrupted,S::Occupancy::unknown,{}));assert(s.snapshot().generation==S::GenerationStatus::unknown);
 assert(!s.beginGeneration("request-2","guitar",u"x")->send);
 assert(s.applyJob(a->request,"job-1",S::JobStatus::ready,S::Occupancy::released,"result-1"));assert(s.snapshot().generation==S::GenerationStatus::ready);assert(s.snapshot().resultId=="result-1");
 auto b=s.beginGeneration("request-2","guitar",u"variation");assert(b && b->send && b->request.requestId=="request-2");
}
static void epochs() {
 S s;ready(s);auto a=s.beginGeneration("r","piano",u"p");assert(a);auto oldReadiness=s.beginReadiness();auto oldEpoch=s.epoch();s.pair("session");assert(s.epoch()!=oldEpoch);
 assert(!s.applyReadiness(oldReadiness,{"prep-1",true,{}, {"piano"}}));assert(!s.applyGeneration(a->request,{"r","session","project","capture-1","prep-1","binding-1","piano",u"p",S::IntentStatus::submitted,"job",{}}));
 assert(s.snapshot().generation==S::GenerationStatus::unknown);assert(!s.canGenerate("piano",u"p"));
 assert(!s.reconcileReleased(oldEpoch));assert(s.reconcileReleased(s.epoch()));assert(s.snapshot().generation==S::GenerationStatus::idle);s.restore();assert(!s.snapshot().paired && !s.snapshot().reference && !s.canGenerate("piano",u""));
}
static void invalid_receipt() {
 S s;ready(s);auto a=s.beginGeneration("r","guitar",u"x");assert(a);
 assert(!s.applyGeneration(a->request,{"r","session","project","capture-1","prep-1","binding-1","piano",u"x",S::IntentStatus::submitted,"job",{}}));
 assert(!s.applyJob(a->request,"job",S::JobStatus::ready,S::Occupancy::released,"result"));
 auto altered=a->request;altered.prompt=u"other";
 assert(!s.applyGeneration(altered,{"r","session","project","capture-1","prep-1","binding-1","guitar",u"other",S::IntentStatus::submitted,"job",{}}));
 s.outcomeUnknown(a->request);assert(s.snapshot().generation==S::GenerationStatus::unknown);
}
static void receipts() {
 S s;ready(s);auto a=s.beginGeneration("req","guitar",u"");assert(a);
 auto pending=S::GenerationReceipt{"req","session","project","capture-1","prep-1","binding-1","guitar",u"Add an instrumental layer",S::IntentStatus::pending,{}, {}};
 assert(s.applyGeneration(a->request,pending));assert(s.snapshot().generation==S::GenerationStatus::checking);
 pending.state=S::IntentStatus::canceled;assert(s.applyGeneration(a->request,pending));assert(s.snapshot().generation==S::GenerationStatus::canceled);
 assert(!s.beginGeneration("req","guitar",u""));assert(s.beginGeneration("next","guitar",u""));
}
static void server_identity() {
 S s;s.pair("session");auto p=s.beginPrepare("client-prep","capture-1",8);assert(p);
 S::PrepareReceipt receipt{"server-prep","session","project","capture-1",S::PrepareStatus::pending,{},{}};
 assert(s.applyPrepare(*p,receipt));auto foreign=receipt;foreign.requestId="foreign";assert(!s.applyPrepare(*p,foreign));
 receipt.state=S::PrepareStatus::prepared;receipt.bindingId="binding-1";assert(s.applyPrepare(*p,receipt));
 assert(s.snapshot().reference->preparedRequestId=="server-prep");
 assert(s.applyReadiness(s.beginReadiness(),{"server-prep",true,{}, {"guitar"}}));
 auto a=s.beginGeneration("client-gen","guitar",u"hello");assert(a);
 S::GenerationReceipt g{"server-gen","session","project","capture-1","server-prep","binding-1","guitar",u"hello",S::IntentStatus::pending,{},{}};
 assert(s.applyGeneration(a->request,g));auto wrong=g;wrong.requestId="foreign";assert(!s.applyGeneration(a->request,wrong));
 g.state=S::IntentStatus::submitted;g.jobId="job";assert(s.applyGeneration(a->request,g));
 assert(s.applyJob(a->request,"job",S::JobStatus::running,S::Occupancy::occupied,{}));
}
static void normalized_prompt() {
 for(auto raw:{std::u16string(),std::u16string(u" \t\u3000\u00a0")}) {
  S s;ready(s);auto a=s.beginGeneration("r","guitar",raw);assert(a);
  auto retry=s.beginGeneration("ignored","piano",u"other");assert(retry && retry->request.prompt==raw);
  S::GenerationReceipt g{"r","session","project","capture-1","prep-1","binding-1","guitar",u"Add an instrumental layer",S::IntentStatus::pending,{},{}};
  assert(s.applyGeneration(a->request,g));
 }
 S s;ready(s);auto a=s.beginGeneration("r","guitar",u" hello ");assert(a);
 S::GenerationReceipt g{"r","session","project","capture-1","prep-1","binding-1","guitar",u"hello",S::IntentStatus::pending,{},{}};
 assert(!s.applyGeneration(a->request,g));g.prompt=u" hello ";assert(s.applyGeneration(a->request,g));
}
int main(int argc,char** argv){if(argc>1 && std::string(argv[1])=="identity"){server_identity();return 0;}if(argc>1 && std::string(argv[1])=="prompt"){normalized_prompt();return 0;}prompts();replacement();intent();epochs();invalid_receipt();receipts();server_identity();normalized_prompt();std::cout<<"PASS generation state\n";}
