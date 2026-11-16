#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_cryptography/juce_cryptography.h>
#include "CaptureRing.h"
#include "DirectGenerationState.h"
#include "GenerationState.h"
#include "GenerationClient.h"
#include "ResultDragButton.h"
#include "ResultCatalogClient.h"
#include "ResultCatalogView.h"
#include "NativeVisibility.h"
#include <mutex>
#include <cmath>

static std::u16string utf16Units(const juce::String& value) {
 auto encoded=value.toUTF16();const auto* unit=encoded.getAddress();std::u16string result;
 while(*unit)result.push_back(static_cast<char16_t>(*unit++));
 return result;
}

class BridgeProcessor final : public juce::AudioProcessor, private juce::Thread {
public:
 explicit BridgeProcessor(unsigned short port=5176): AudioProcessor(BusesProperties().withInput("Input",juce::AudioChannelSet::stereo(),true).withOutput("Output",juce::AudioChannelSet::stereo(),true)), Thread("ACE Bridge worker"), bridgePort(port) { startThread(); catalogThread=std::thread([this]{catalogLoop();}); }
 ~BridgeProcessor() override { {std::lock_guard<std::mutex> lock(mutex);catalogStop=true;}catalogWake.notify_one();catalogRequestStop.stop();if(catalogThread.joinable())catalogThread.join();signalThreadShouldExit(); stopThread(-1); }
 const juce::String getName() const override { return "ACE-Step Bridge"; }
 void prepareToPlay(double rate,int) override { sampleRate.store(rate); }
 void releaseResources() override { ring.cancel(); }
 bool isBusesLayoutSupported(const BusesLayout& b) const override { auto c=b.getMainInputChannelSet(); return (c==juce::AudioChannelSet::mono() || c==juce::AudioChannelSet::stereo()) && c==b.getMainOutputChannelSet(); }
 void processBlock(juce::AudioBuffer<float>& buffer,juce::MidiBuffer&) override {
  CaptureRing::Position p{};p.available=0;
  if(auto* ph=getPlayHead()) if(auto pos=ph->getPosition()) {
   p.playing=pos->getIsPlaying(); auto sample=pos->getTimeInSamples(); auto bpm=pos->getBpm(); auto meter=pos->getTimeSignature();
   p.available=(sample.hasValue()?1u:0u)|(bpm.hasValue()?2u:0u)|(meter.hasValue()?4u:0u);
   p.valid=p.available==7;
   if(p.valid) {p.sample=*sample;p.tempo=*bpm;p.numerator=meter->numerator;p.denominator=meter->denominator;}
  }
  ring.process(buffer.getArrayOfReadPointers(),buffer.getNumSamples(),p,sampleRate.load(),buffer.getNumChannels());
 }
 bool acceptsMidi() const override {return false;} bool producesMidi() const override {return false;}
 double getTailLengthSeconds() const override {return 0;} int getNumPrograms() override {return 1;}
 int getCurrentProgram() override {return 0;} void setCurrentProgram(int) override {}
 const juce::String getProgramName(int) override {return {};}
 void changeProgramName(int,const juce::String&) override {}
 bool hasEditor() const override {return true;} juce::AudioProcessorEditor* createEditor() override;
 void getStateInformation(juce::MemoryBlock& b) override { std::lock_guard<std::mutex> lock(mutex);juce::MemoryOutputStream s(b,false);s.writeString(juce::JSON::toString(object({{"stateId",stateId},{"sessionDisplay",sessionDisplay},{"captureSeconds",captureSeconds},{"resultId",savedResultId},{"cachedFilename",cachedFilename},{"cacheVersion",cacheVersion}}))); }
 void setStateInformation(const void* data,int bytes) override { juce::MemoryInputStream s(data,static_cast<size_t>(bytes),false);auto saved=juce::JSON::parse(s.readString());if(!saved.isObject())return;std::lock_guard<std::mutex> lock(mutex);stateId=saved["stateId"].toString();sessionDisplay=saved["sessionDisplay"].toString();captureSeconds=juce::jlimit(1,120,static_cast<int>(saved["captureSeconds"]));savedResultId=saved["resultId"].toString();cachedFilename=saved["cachedFilename"].toString();cacheVersion=static_cast<int>(saved["cacheVersion"]);++selectionRevision;++stateRevision;direct.reset();generation.restore();generationPrepare.reset();generationActive.reset();generationReceipt.clear();directFetching=false;directDelivered=false;catalog.restore();catalogWake.notify_one();credentialsResetRequested=true;pendingRevision=selectionRevision;pendingStateRevision=stateRevision;localResult=juce::File();placementText.clear();if(pending=="capture")captureReserved=false;pending.clear();argument.clear();if(!cachedFilename.isEmpty()){pending="restore";argument.clear();message="Restoring cached result";}else message="Disconnected"; }
 void command(juce::String op,juce::String arg={}) {
  std::lock_guard<std::mutex> lock(mutex);
  commandLocked(op,arg);
 }
 void probeDirectThenCancel(const juce::String& prompt) {
  std::lock_guard<std::mutex> lock(mutex);
  commandLocked("direct",prompt);
  commandLocked("cancel",{});
 }
 void commandLocked(juce::String op,juce::String arg={}) {
  if(op=="mode"){if(captureReserved || direct.busy() || directFetching || generationActive || generationPrepare || generation.snapshot().generation==GenerationState::GenerationStatus::unknown || pending.isNotEmpty())return;layerMode=arg!="cover";return;}
  if(op=="instrument"){selectedInstrument=arg;return;}
  if(op=="pair"){++stateRevision;generation.restore();generationPrepare.reset();generationActive.reset();generationReceipt.clear();}
  if(op=="generate") {
   if(captureReserved || direct.busy() || directFetching || pending.isNotEmpty())return;
   auto started=generation.beginGeneration(juce::Uuid().toString().toStdString(),selectedInstrument.toStdString(),utf16Units(arg));
   if(started && started->send){generationActive=started->request;generationReceipt.clear();generationPost=true;nextGenerationPoll=0;}
   return;
  }
  if(op=="cancel-generation"){if(generationActive){generation.cancelRequested();generationCancel=true;nextGenerationPoll=0;}return;}
  if(op=="direct") {
   if(captureReserved || directFetching || generationActive || generationPrepare || pending.isNotEmpty())return;
   auto text=utf16Units(arg);
   auto request=direct.begin(juce::Uuid().toString().toStdString(),std::move(text));
   if(!request){message="Capture audio and enter a prompt (up to 4096 UTF-16 units)";return;}
   directDelivered=false;pending=op;argument=arg;pendingRevision=selectionRevision;pendingStateRevision=stateRevision;
   return;
  }
  if(direct.busy() || directFetching || generationActive || generationPrepare)return;
  if(op=="result" && captureReserved)return;
  if(op=="capture"){if(captureReserved)return;captureReserved=true;captureSeconds=juce::jlimit(1,120,arg.getIntValue());}
  else if(pending=="capture")captureReserved=false;
  if(op=="result"){savedResultId=arg;cachedFilename.clear();cacheVersion=1;localResult=juce::File();placementText.clear();++selectionRevision;message="Fetching result";}
  pending=op;argument=arg;pendingRevision=selectionRevision;pendingStateRevision=stateRevision;
 }
 struct DirectSnapshot {juce::String source,status;bool paired,busy,hasSource;};
 DirectSnapshot directSnapshot() {
  std::lock_guard<std::mutex> lock(mutex);
  juce::String source=direct.sourceId().empty()?"No captured audio":"Source: "+juce::String(direct.sourceId()).substring(0,8)+"  |  "+juce::String(direct.duration(),2)+" s";
  juce::String status;
  switch(direct.status()) {
   case DirectGenerationState::Status::idle: status="Capture audio, then describe the sound";break;
   case DirectGenerationState::Status::submitting: status="Submitting Cover request";break;
   case DirectGenerationState::Status::queued: status="Queued";break;
   case DirectGenerationState::Status::running: status="Generating";break;
   case DirectGenerationState::Status::unknown: status="Outcome unknown; checking status";break;
   case DirectGenerationState::Status::ready: status=directFetching?"Fetching WAV":"Generation ready";break;
   case DirectGenerationState::Status::failed: status="Generation failed: "+juce::String(direct.error());break;
  }
  return {source,status,direct.paired(),direct.busy() || directFetching,!direct.sourceId().empty()};
 }
 bool layerModeSelected(){std::lock_guard<std::mutex> lock(mutex);return layerMode;}
 bool generationCanGenerate(const juce::String& instrument,const juce::String& prompt){std::lock_guard<std::mutex> lock(mutex);return generation.canGenerate(instrument.toStdString(),utf16Units(prompt));}
 GenerationState::Snapshot generationSnapshot(){std::lock_guard<std::mutex> lock(mutex);return generation.snapshot();}
 bool generationHasActive(){std::lock_guard<std::mutex> lock(mutex);return generationActive.has_value();}
 juce::String generationProbe(){auto s=generationSnapshot();return juce::String(s.preparation==GenerationState::PreparationStatus::prepared?"prepared":"preparing")+" "+(s.readiness.ready?"ready":"not-ready")+" result="+juce::String(s.resultId)+" generation="+juce::String(static_cast<int>(s.generation))+" error="+juce::String(s.error)+" preparation="+juce::String(static_cast<int>(s.preparation))+" reference="+(s.reference?juce::String(s.reference->preparedRequestId):juce::String());}
 juce::String promptText(){std::lock_guard<std::mutex> lock(mutex);return savedPrompt;}
 void setPromptText(const juce::String& text){std::lock_guard<std::mutex> lock(mutex);savedPrompt=text;}

 void catalogVisible(bool visible) {std::lock_guard<std::mutex> lock(mutex);catalog.setVisible(visible);if(visible)catalog.refresh();catalogWake.notify_one();}
 int port() const {return bridgePort;}
 int catalogQos() const {return catalogQosValue.load();}
 void catalogRefresh() {std::lock_guard<std::mutex> lock(mutex);catalog.refresh();catalogWake.notify_one();}
 void catalogOlder(const std::string& cursor) {std::lock_guard<std::mutex> lock(mutex);catalog.older(cursor);catalogWake.notify_one();}
 void catalogLatest() {std::lock_guard<std::mutex> lock(mutex);catalog.latest();catalogWake.notify_one();}
 void catalogDismiss() {std::lock_guard<std::mutex> lock(mutex);catalog.dismissNotice();}
 struct CatalogSnapshot {ResultCatalogState::Page page;bool paired,visible,inFlight,baseline,notice,stale;int retrySeconds;};
 CatalogSnapshot catalogSnapshot() {std::lock_guard<std::mutex> lock(mutex);return {catalog.rows(),catalog.paired(),catalog.visible(),catalog.inFlight(),catalog.baseline(),catalog.notice(),catalog.stale(),catalog.retrySeconds()};}
 juce::String savedResult(){std::lock_guard<std::mutex> lock(mutex);return savedResultId;}
 int savedSeconds(){std::lock_guard<std::mutex> lock(mutex);return captureSeconds;}
 juce::String status() {std::lock_guard<std::mutex> lock(mutex);return message;}
 unsigned requestCount() const {return networkRequests.load();}
 juce::String placement(){std::lock_guard<std::mutex> lock(mutex);return placementText;}
 juce::File result() {std::lock_guard<std::mutex> lock(mutex);return localResult;}
private:
 const unsigned short bridgePort;
 ResultCatalogState catalog;ResultCatalogClient::StopControl catalogRequestStop;
 std::thread catalogThread;std::condition_variable catalogWake;bool catalogStop=false;std::atomic<int> catalogQosValue{-1};
 void catalogLoop() {
#if JUCE_MAC
  const auto setResult=pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND,0);qos_class_t actualClass=QOS_CLASS_UNSPECIFIED;int relativePriority=0;
  const auto getResult=pthread_get_qos_class_np(pthread_self(),&actualClass,&relativePriority);
  if(setResult!=0 || getResult!=0 || actualClass!=QOS_CLASS_BACKGROUND) {juce::Logger::writeToLog("Catalog worker QoS setup failed: set="+juce::String(setResult)+" get="+juce::String(getResult)+" class="+juce::String(static_cast<int>(actualClass)));catalogQosValue.store(-2);}
  else catalogQosValue.store(static_cast<int>(actualClass));
#else
  catalogQosValue.store(0);
#endif
  auto next=std::chrono::steady_clock::time_point::max();
  std::unique_lock<std::mutex> lock(mutex);
  while(!catalogStop) {
   if(catalog.visible() && catalog.paired() && std::chrono::steady_clock::now()>=next){catalog.refresh();next=std::chrono::steady_clock::time_point::max();}
   auto request=catalog.begin();
   if(request){lock.unlock();auto page=ResultCatalogClient::fetch(*request,catalogRequestStop,bridgePort);lock.lock();if(page)catalog.succeed(*request,std::move(*page));else catalog.fail(*request);next=std::chrono::steady_clock::now()+std::chrono::seconds(catalog.retrySeconds());continue;}
   if(catalog.visible() && catalog.paired() && next!=std::chrono::steady_clock::time_point::max())catalogWake.wait_until(lock,next);else catalogWake.wait(lock);
  }
 }
 CaptureRing ring;
 std::atomic<double> sampleRate{48000};
 std::mutex mutex;
 juce::String pending,argument,message="Disconnected",token,sessionId,sessionDisplay,savedResultId,cachedFilename,savedPrompt;
 GenerationState generation;std::optional<GenerationState::PrepareRequest> generationPrepare;std::optional<GenerationState::GenerationRequest> generationActive;
 juce::String generationReceipt,selectedInstrument;bool layerMode=true,generationPost=false,generationCancel=false;double nextGenerationPoll=0;
 DirectGenerationState direct;bool directFetching=false,directDelivered=false;double nextDirectPoll=0;
 std::atomic<unsigned> networkRequests{0};
 uint64_t selectionRevision=0,pendingRevision=0,stateRevision=0,pendingStateRevision=0;
 bool credentialsResetRequested=false,captureReserved=false;
 int captureSeconds=8,cacheVersion=1;
 juce::String stateId=juce::Uuid().toString(),instanceId=juce::Uuid().toString();
 juce::File localResult;
 juce::String placementText;
 void show(juce::String s) {std::lock_guard<std::mutex> lock(mutex);message=s;}
 juce::var request(juce::String method,juce::String path,juce::var body={},const juce::MemoryBlock* binary=nullptr,juce::String extra={}) {
  networkRequests.fetch_add(1);
  if(path=="/direct-jobs" || path.startsWith("/direct-jobs/") || path.startsWith("/direct-jobs?")) {
   const auto credential=token;const auto response=GenerationClient::request(bridgePort,credential,method,path,body);
   if(response.valid)return response.body;
   if(response.parsed && response.status>=400 && response.status<600)throw juce::String("HTTP ")+juce::String(response.status)+": "+response.body["error"]["message"].toString();
   throw juce::String("Service unavailable or invalid response");
  }
  juce::URL url("http://127.0.0.1:"+juce::String(bridgePort)+"/v1"+path);
  if(binary) url=url.withPOSTData(*binary); else if(!body.isVoid()) url=url.withPOSTData(juce::JSON::toString(body));
  int code=0;
  auto headers="X-Bridge-Protocol: 1\r\nAuthorization: Bearer "+token+"\r\nContent-Type: "+(binary?juce::String("application/octet-stream"):juce::String("application/json"))+"\r\n"+extra;
  const int timeoutMs=(method=="POST" && path.startsWith("/captures/") && path.endsWith("/finalize"))?30000:3000;
  auto stream=url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress).withHttpRequestCmd(method).withExtraHeaders(headers).withConnectionTimeoutMs(timeoutMs).withStatusCode(&code).withNumRedirectsToFollow(0));
  if(!stream) throw juce::String("Service unavailable");
  auto response=juce::JSON::parse(stream->readEntireStreamAsString());
  if(code<200 || code>=300) throw juce::String("HTTP ")+juce::String(code)+": "+response["error"]["message"].toString();
  return response;
 }
 static juce::var object(std::initializer_list<std::pair<juce::Identifier,juce::var>> values) {auto* o=new juce::DynamicObject();for(const auto& v:values)o->setProperty(v.first,v.second);return juce::var(o);}
 void upload(const juce::MemoryBlock& pcm,uint64_t hostRevision) {
  show("Uploading");
  auto c=request("POST","/captures",object({{"sessionId",sessionId},{"instanceId",instanceId},{"label","Logic insert"},{"sampleRate",ring.rate},{"channels",ring.channels},{"expectedFrames",static_cast<juce::int64>(ring.target)},{"hostStartSample",static_cast<juce::int64>(ring.start.sample)},{"tempo",ring.start.tempo},{"timeSignature",juce::Array<juce::var>{ring.start.numerator,ring.start.denominator}}}));
  auto id=c["captureId"].toString();
  try {
   size_t offset=0;int sequence=0;
   while(offset<pcm.getSize()) {
    auto n=std::min<size_t>(1024*1024,pcm.getSize()-offset);juce::MemoryBlock chunk(static_cast<const char*>(pcm.getData())+offset,n);
    request("PUT","/captures/"+id+"/chunks/"+juce::String(sequence++),{},&chunk,"X-Chunk-SHA256: "+juce::SHA256(chunk).toHexString()+"\r\nX-Start-Frame: "+juce::String(static_cast<juce::int64>(offset/(4*ring.channels)))+"\r\n"); offset+=n;
   }
   auto ready=request("POST","/captures/"+id+"/finalize",object({{"sha256",juce::SHA256(pcm).toHexString()}}));
   if(ready["state"].toString()!="ready") throw juce::String("Canonical conversion is not ready");
   {std::lock_guard<std::mutex> lock(mutex);if(hostRevision==stateRevision){direct.captureReady(sessionId.toStdString(),id.toStdString(),static_cast<double>(ready["canonicalFrameCount"])/48000.0);generation.setCapture(GenerationState::CaptureStatus::ready);if(layerMode)generationPrepare=generation.beginPrepare(juce::Uuid().toString().toStdString(),id.toStdString(),static_cast<double>(ready["canonicalFrameCount"])/48000.0);generationReceipt.clear();generationPost=static_cast<bool>(generationPrepare);nextGenerationPoll=0;message="Captured: "+id;}}
  } catch(...) {try{request("POST","/captures/"+id+"/cancel",object({}));}catch(...){}throw;}
 }
 static juce::String checkedPlacement(const juce::var& value) {
  if(!(value.isDouble() || value.isInt() || value.isInt64()) || !std::isfinite(static_cast<double>(value)))throw juce::String("Suggested placement must be finite numeric seconds");
  auto seconds=static_cast<double>(value);if(seconds==0)seconds=0;
  return "Suggested start: "+juce::String(seconds>=0?"+":"")+juce::String(seconds,6)+" s";
 }
 static juce::File resultDirectory() {return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("ACE-Step Bridge/native-results");}
 static juce::File writeResultPair(const juce::File& directory,const juce::MemoryBlock& bytes,const juce::var& metadata) {
  if(directory.isSymbolicLink() || directory.createDirectory().failed())throw juce::String("Cannot create result directory");
  auto file=directory.getChildFile(juce::Uuid().toString()+".wav");auto sidecar=file.withFileExtension("json");
  if(file.exists() || sidecar.exists())throw juce::String("Result filename collision");
  if(!file.replaceWithData(bytes.getData(),bytes.getSize()))throw juce::String("Cannot save result");
  if(!sidecar.replaceWithText(juce::JSON::toString(metadata))){file.deleteFile();throw juce::String("Cannot save result metadata");}
  return file;
 }
 void fetchResult(const juce::String& id,uint64_t revision) {
  {std::lock_guard<std::mutex> lock(mutex);if(revision!=selectionRevision)return;}
  auto metadata=request("GET","/results/"+id);
  auto placement=checkedPlacement(metadata["placementSeconds"]);
  if(metadata["resultId"].toString()!=id)throw juce::String("Result metadata ID mismatch");
  auto asset=metadata["audioAssetId"].toString(); if(asset.isEmpty()) asset=metadata["assetId"].toString();
  if(asset.isEmpty()) throw juce::String("Result has no audio asset");
  networkRequests.fetch_add(1);
  int code=0;juce::URL url("http://127.0.0.1:"+juce::String(bridgePort)+"/v1/assets/"+asset);
  auto stream=url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress).withExtraHeaders("Authorization: Bearer "+token+"\r\n").withConnectionTimeoutMs(3000).withStatusCode(&code).withNumRedirectsToFollow(0));
  if(!stream || code!=200) throw juce::String("Result download failed");
  juce::MemoryBlock bytes; constexpr size_t maxBytes=64*1024*1024; std::array<char,65536> block{}; while(!stream->isExhausted()){auto n=stream->read(block.data(),static_cast<int>(block.size()));if(n<=0)break;if(bytes.getSize()+static_cast<size_t>(n)>maxBytes)throw juce::String("Result exceeds 64 MiB limit");bytes.append(block.data(),static_cast<size_t>(n));}
  auto hash=metadata["sha256"].toString(); if(hash.isEmpty() || juce::SHA256(bytes).toHexString()!=hash) throw juce::String("Result hash mismatch");
  juce::WavAudioFormat wav; auto reader=std::unique_ptr<juce::AudioFormatReader>(wav.createReaderFor(new juce::MemoryInputStream(bytes,false),true));
  if(!reader || reader->lengthInSamples<=0 || reader->sampleRate!=48000 || reader->numChannels!=2 || reader->lengthInSamples!=static_cast<juce::int64>(metadata["frameCount"])) throw juce::String("Invalid WAV format or frame count");
  const auto canonical=writeResultPair(resultDirectory().getChildFile("verified-cache"),bytes,metadata);
  const auto exported=writeResultPair(resultDirectory(),bytes,metadata);
  {std::lock_guard<std::mutex> lock(mutex);if(revision==selectionRevision){localResult=exported;placementText=placement;cachedFilename=canonical.getFileName();cacheVersion=1;savedResultId=id;message="Result ready: "+exported.getFileName();}}
 }
 void restoreCachedResult() {
  juce::String name,id;int version=0;uint64_t revision=0;{std::lock_guard<std::mutex> lock(mutex);name=cachedFilename;id=savedResultId;version=cacheVersion;revision=selectionRevision;localResult=juce::File();placementText.clear();}
  try {
   if(version!=0 && version!=1)throw juce::String("unsupported cache version");
   const auto stem=name.dropLastCharacters(4);
   if(!name.endsWith(".wav") || name.length()>128 || stem.isEmpty() || !stem.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw juce::String("invalid cache filename");
   auto directory=version==1?resultDirectory().getChildFile("verified-cache"):resultDirectory();
   if(directory.isSymbolicLink())throw juce::String("invalid cache directory");
   auto file=directory.getChildFile(name);auto sidecar=file.withFileExtension("json");
   if(file.isSymbolicLink() || sidecar.isSymbolicLink() || !file.existsAsFile() || !sidecar.existsAsFile())throw juce::String("cached file or metadata is missing");
   if(file.getSize()<=0 || file.getSize()>64*1024*1024 || sidecar.getSize()>65536)throw juce::String("invalid cache size");
   auto metadata=juce::JSON::parse(sidecar);auto placement=checkedPlacement(metadata["placementSeconds"]);juce::MemoryBlock bytes;
   if(id.isEmpty() || metadata["resultId"].toString()!=id || !file.loadFileAsData(bytes) || juce::SHA256(bytes).toHexString()!=metadata["sha256"].toString())throw juce::String("cache integrity check failed");
   juce::WavAudioFormat format;auto reader=std::unique_ptr<juce::AudioFormatReader>(format.createReaderFor(new juce::MemoryInputStream(bytes,false),true));
   if(!reader || reader->sampleRate!=48000 || reader->numChannels!=2 || reader->lengthInSamples<=0 || reader->lengthInSamples!=static_cast<juce::int64>(metadata["frameCount"]))throw juce::String("cached WAV format or frame count is invalid");
   const auto canonical=version==0?writeResultPair(resultDirectory().getChildFile("verified-cache"),bytes,metadata):file;
   const auto exported=writeResultPair(resultDirectory(),bytes,metadata);
   {std::lock_guard<std::mutex> lock(mutex);if(revision==selectionRevision){cachedFilename=canonical.getFileName();cacheVersion=1;localResult=exported;placementText=placement;message="Result ready: "+exported.getFileName();}}
  }catch(const juce::String& error){std::lock_guard<std::mutex> lock(mutex);if(revision==selectionRevision)message="Cache unavailable: "+error+". Re-pair and fetch the result again.";}
 }
 juce::String captureFailure() const {
  switch(ring.failure.load()) {
   case CaptureRing::Failure::None: return "Failed: unspecified capture error";
   case CaptureRing::Failure::FormatChanged: return "Failed: sample rate or channel count changed";
   case CaptureRing::Failure::MissingHostPosition: return "Failed: missing host metadata (mask "+juce::String(ring.missingHostFields.load())+"; sample=1 tempo=2 meter=4)";
   case CaptureRing::Failure::TransportStopped: return "Failed: host transport stopped";
   case CaptureRing::Failure::PositionDiscontinuity: return "Failed: host seek/loop; expected "+juce::String(static_cast<juce::int64>(ring.expectedSample.load()))+", got "+juce::String(static_cast<juce::int64>(ring.observedSample.load()));
   case CaptureRing::Failure::TempoChanged: return "Failed: host tempo changed";
   case CaptureRing::Failure::MeterChanged: return "Failed: host meter changed";
   case CaptureRing::Failure::Overflow: return "Failed: capture ring overflow";
  }
  return "Failed: unknown capture error";
 }
 void submitDirect(const juce::String& prompt) {
  std::optional<DirectGenerationState::Request> active;
  {std::lock_guard<std::mutex> lock(mutex);active=direct.active();}
  if(!active)return;
  try {
   auto reply=request("POST","/direct-jobs",object({{"sessionId",juce::String(active->sessionId)}, {"captureId",juce::String(active->captureId)}, {"clientRequestId",juce::String(active->clientRequestId)}, {"prompt",prompt}}));
   std::lock_guard<std::mutex> lock(mutex);
   if(!direct.apply(*active,reply["requestId"].toString().toStdString(),reply["sessionId"].toString().toStdString(),reply["captureId"].toString().toStdString(),reply["state"].toString().toStdString(),reply["resultId"].toString().toStdString(),reply["error"].toString().toStdString()))direct.outcomeUnknown(*active);
  } catch(const juce::String& error) {
   std::lock_guard<std::mutex> lock(mutex);
   const auto code=error.startsWith("HTTP ")?error.substring(5,8).getIntValue():0;
   if(code>=400 && code<500 && code!=408)direct.rejected(*active,error.toStdString());else direct.outcomeUnknown(*active);
  }
  nextDirectPoll=0;
 }
 void pollDirect() {
  std::optional<DirectGenerationState::Request> active;juce::String serverId;bool needsPoll=false;
  {std::lock_guard<std::mutex> lock(mutex);
   if(!direct.active() || directFetching)return;
   active=direct.active();serverId=direct.serverId();
   needsPoll=direct.busy() || (direct.status()==DirectGenerationState::Status::ready && direct.resultId().empty());
   if(direct.status()==DirectGenerationState::Status::ready && !direct.resultId().empty() && !directDelivered)needsPoll=true;
  }
  if(!needsPoll || juce::Time::getMillisecondCounterHiRes()<nextDirectPoll)return;
  nextDirectPoll=juce::Time::getMillisecondCounterHiRes()+1500;
  try {
   juce::var reply;
   if(serverId.isNotEmpty())reply=request("GET","/direct-jobs/"+juce::URL::addEscapeChars(serverId,false));
   else reply=request("GET","/direct-jobs?sessionId="+juce::URL::addEscapeChars(juce::String(active->sessionId),true)+"&clientRequestId="+juce::URL::addEscapeChars(juce::String(active->clientRequestId),true));
   juce::String result;uint64_t revision=0;
   {std::lock_guard<std::mutex> lock(mutex);
    if(!direct.apply(*active,reply["requestId"].toString().toStdString(),reply["sessionId"].toString().toStdString(),reply["captureId"].toString().toStdString(),reply["state"].toString().toStdString(),reply["resultId"].toString().toStdString(),reply["error"].toString().toStdString())){direct.outcomeUnknown(*active);return;}
    if(direct.status()==DirectGenerationState::Status::ready){result=juce::String(direct.resultId());directFetching=true;revision=selectionRevision;}
   }
   if(result.isNotEmpty()) {
    try {fetchResult(result,revision);}
    catch(const juce::String& error) {std::lock_guard<std::mutex> lock(mutex);if(direct.matches(*active))message="Generation ready; WAV download failed: "+error+". Fetch it from Results.";}
    std::lock_guard<std::mutex> lock(mutex);if(direct.matches(*active)){directFetching=false;directDelivered=true;}
   }
  } catch(const juce::String&) {std::lock_guard<std::mutex> lock(mutex);direct.outcomeUnknown(*active);}
 }

 void pollGeneration() {
  std::optional<GenerationState::PrepareRequest> prep;std::optional<GenerationState::GenerationRequest> active;juce::String credential,session,receipt;bool post=false,cancel=false;GenerationState::ReadinessRequest readinessRequest{};
  {std::lock_guard<std::mutex> lock(mutex);if(token.isEmpty() || juce::Time::getMillisecondCounterHiRes()<nextGenerationPoll)return;
   nextGenerationPoll=juce::Time::getMillisecondCounterHiRes()+750;credential=token;session=sessionId;prep=generationPrepare;active=generationActive;receipt=generationReceipt;post=generationPost;cancel=generationCancel;generationPost=false;if(!cancel || receipt.isNotEmpty())generationCancel=false;readinessRequest=generation.beginReadiness();}
  auto escape=[](const juce::String& value){return juce::URL::addEscapeChars(value,true);};
  auto query="?sessionId="+escape(session)+"&clientRequestId="+escape(juce::String(prep?prep->requestId:active?active->requestId:std::string()));
  if(prep || active) {
   juce::String path;juce::String method="GET";juce::var body;
   if(cancel && receipt.isNotEmpty()){method="POST";path="/native-requests/"+escape(receipt)+"/cancel";body=object({});}
   else if(post){method="POST";path="/native-requests";if(prep)body=object({{"kind","prepare"},{"sessionId",session},{"captureId",juce::String(prep->captureId)},{"clientRequestId",juce::String(prep->requestId)}});else body=object({{"kind","generation"},{"sessionId",session},{"preparedRequestId",juce::String(active->preparedRequestId)},{"instrument",juce::String(active->instrument)},{"prompt",juce::String(juce::CharPointer_UTF16(reinterpret_cast<const juce::CharPointer_UTF16::CharType*>(active->prompt.c_str())))},{"clientRequestId",juce::String(active->requestId)}});}
   else path=receipt.isNotEmpty()?"/native-requests/"+escape(receipt):"/native-requests"+query;
   auto reply=GenerationClient::request(bridgePort,credential,method,path,body);
   std::lock_guard<std::mutex> lock(mutex);
   if((prep && (!generationPrepare || generationPrepare->epoch!=prep->epoch)) || (active && (!generationActive || generationActive->epoch!=active->epoch)))return;
   if(!reply.valid){
    if(prep && post && reply.parsed && reply.status>=400 && reply.status<500 && reply.status!=408){auto error=reply.body["error"]["message"].toString();if(error.isEmpty())error="Preparation rejected";if(generation.rejectPrepare(*prep,error.toStdString())){generationPrepare.reset();generationReceipt.clear();}}
    else if(prep)generation.prepareOutcomeUnknown(*prep);
    if(active){if(post && reply.parsed && reply.status>=400 && reply.status<500 && reply.status!=408){auto error=reply.body["error"]["message"].toString();if(error.isEmpty())error="Generation rejected";if(generation.rejectGeneration(*active,error.toStdString())){generationActive.reset();generationReceipt.clear();}}else generation.outcomeUnknown(*active);}return;
   }
   auto r=reply.body;auto state=r["state"].toString();auto id=r["requestId"].toString();
   if(prep){if(state!="pending" && state!="prepared" && state!="failed" && state!="canceled"){generation.prepareOutcomeUnknown(*prep);return;}GenerationState::PrepareStatus parsed=state=="prepared"?GenerationState::PrepareStatus::prepared:state=="failed"?GenerationState::PrepareStatus::failed:state=="canceled"?GenerationState::PrepareStatus::canceled:GenerationState::PrepareStatus::pending;
    if(!generation.applyPrepare(*prep,{id.toStdString(),r["sessionId"].toString().toStdString(),r["projectId"].toString().toStdString(),r["captureId"].toString().toStdString(),parsed,r["bindingId"].toString().toStdString(),r["error"].toString().toStdString()})){generation.prepareOutcomeUnknown(*prep);return;}
    generationReceipt=id;if(parsed!=GenerationState::PrepareStatus::pending){generationPrepare.reset();generationReceipt.clear();nextGenerationPoll=0;}}
   else {if(state!="pending" && state!="submitted" && state!="failed" && state!="canceled"){generation.outcomeUnknown(*active);return;}GenerationState::IntentStatus parsed=state=="submitted"?GenerationState::IntentStatus::submitted:state=="failed"?GenerationState::IntentStatus::failed:state=="canceled"?GenerationState::IntentStatus::canceled:GenerationState::IntentStatus::pending;
    GenerationState::GenerationReceipt value{id.toStdString(),r["sessionId"].toString().toStdString(),r["projectId"].toString().toStdString(),r["captureId"].toString().toStdString(),r["preparedRequestId"].toString().toStdString(),r["bindingId"].toString().toStdString(),r["instrument"].toString().toStdString(),utf16Units(r["prompt"].toString()),parsed,r["jobId"].toString().toStdString(),r["error"].toString().toStdString()};
    if(!generation.applyGeneration(*active,value)){generation.outcomeUnknown(*active);return;}generationReceipt=id;
    if(parsed==GenerationState::IntentStatus::failed || parsed==GenerationState::IntentStatus::canceled){generationActive.reset();generationReceipt.clear();}
   }
  }
  if(active){juce::String job;{std::lock_guard<std::mutex> lock(mutex);job=juce::String(generation.snapshot().jobId);}if(job.isNotEmpty()){
   auto reply=GenerationClient::request(bridgePort,credential,"GET","/jobs/"+escape(job));std::lock_guard<std::mutex> lock(mutex);if(!generationActive || generationActive->epoch!=active->epoch)return;if(!reply.valid || reply.body["jobId"].toString()!=job){generation.outcomeUnknown(*active);return;}
   auto r=reply.body;auto state=r["state"].toString();auto occupancy=r["backendOccupancy"].toString();
   if(state!="ready" && state!="failed" && state!="canceled" && state!="interrupted" && state!="exporting" && state!="running" && state!="dispatched" && state!="queued"){generation.outcomeUnknown(*active);return;}
   auto parsed=state=="ready"?GenerationState::JobStatus::ready:state=="failed"?GenerationState::JobStatus::failed:state=="canceled"?GenerationState::JobStatus::canceled:state=="interrupted"?GenerationState::JobStatus::interrupted:state=="exporting"?GenerationState::JobStatus::exporting:state=="running"?GenerationState::JobStatus::running:state=="dispatched"?GenerationState::JobStatus::dispatched:GenerationState::JobStatus::queued;
   auto occupied=occupancy=="released"?GenerationState::Occupancy::released:occupancy=="occupied"?GenerationState::Occupancy::occupied:occupancy=="reserved"?GenerationState::Occupancy::reserved:GenerationState::Occupancy::unknown;
   if(!generation.applyJob(*active,job.toStdString(),parsed,occupied,r["resultId"].toString().toStdString(),r["error"].isString()?r["error"].toString().toStdString():std::string()))generation.outcomeUnknown(*active);
   auto snapshot=generation.snapshot();if(occupied==GenerationState::Occupancy::released && (snapshot.generation==GenerationState::GenerationStatus::ready || snapshot.generation==GenerationState::GenerationStatus::failed || snapshot.generation==GenerationState::GenerationStatus::canceled || snapshot.generation==GenerationState::GenerationStatus::interrupted)){generationActive.reset();generationReceipt.clear();}
  }}
  auto reply=GenerationClient::request(bridgePort,credential,"GET","/native-readiness?sessionId="+escape(session));if(!reply.valid)return;
  if(!reply.body["ready"].isBool() || !reply.body["instruments"].isArray())return;
  GenerationState::Readiness ready;ready.ready=static_cast<bool>(reply.body["ready"]);ready.preparedRequestId=reply.body["preparedRequestId"].toString().toStdString();ready.reason=reply.body["reason"].toString().toStdString();if(auto* instruments=reply.body["instruments"].getArray())for(const auto& instrument:*instruments)if(instrument.isString())ready.instruments.push_back(instrument.toString().toStdString());
  std::lock_guard<std::mutex> lock(mutex);generation.applyReadiness(readinessRequest,std::move(ready));
 }
 void run() override {
  juce::MemoryBlock pcm; std::array<float,8192> scratch{}; bool active=false,uploading=false;
  uint64_t lastHeartbeat=0;double lastActivity=0;
  while(!threadShouldExit()) {
   juce::String op,arg;uint64_t revision=0,hostRevision=0;{std::lock_guard<std::mutex> lock(mutex);if(credentialsResetRequested){token.clear();sessionId.clear();credentialsResetRequested=false;}op=pending;arg=argument;revision=pendingRevision;hostRevision=pendingStateRevision;pending.clear();}
   try {
    if(op=="restore") restoreCachedResult();
    if(op=="direct" && !active) submitDirect(arg);
    if(op=="pair" && !active) {auto r=request("POST","/pairings/claim",object({{"code",arg}}));if(r["role"].toString()!="native" || r["token"].toString().isEmpty() || r["sessionId"].toString().isEmpty()) throw juce::String("Pairing requires a valid native credential");{std::lock_guard<std::mutex> lock(mutex);if(hostRevision==stateRevision){token=r["token"].toString();sessionId=r["sessionId"].toString();sessionDisplay=sessionId;catalog.pair(sessionId.toStdString(),token.toStdString());direct.pair(sessionId.toStdString());generation.pair(sessionId.toStdString());nextGenerationPoll=0;catalog.refresh();catalogWake.notify_one();message="Ready";}}}
    if(op=="result" && !active) fetchResult(arg,revision);
    if(op=="cancel") ring.cancel();
    if(op=="capture" && !active) {
     if(token.isEmpty()) throw juce::String("Pair with the local service first");
     auto sr=sampleRate.load(); if(sr!=44100 && sr!=48000 && sr!=88200 && sr!=96000) throw juce::String("Unsupported sample rate");
     auto seconds=juce::jlimit(1,120,arg.getIntValue());pcm.reset();pcm.ensureSize(static_cast<size_t>(sr*seconds*getTotalNumInputChannels()*4),true);pcm.setSize(0);
     ring.reset();ring.arm(static_cast<uint64_t>(sr*seconds),sr,getTotalNumInputChannels());active=true;lastHeartbeat=ring.heartbeat.load();lastActivity=juce::Time::getMillisecondCounterHiRes();show("Armed: play the passage");
    }
    if(active) {
     auto state=ring.state.load(); auto n=ring.drain(scratch.data(),4096);if(n) pcm.append(scratch.data(),n*static_cast<uint64_t>(ring.channels)*4);
     auto hb=ring.heartbeat.load();auto now=juce::Time::getMillisecondCounterHiRes();if(hb!=lastHeartbeat){lastHeartbeat=hb;lastActivity=now;}
     if(state==CaptureRing::Capturing) {if(now-lastActivity>2000) {ring.cancel();show("Failed: host processing suspended; resume to reset");} else show("Capturing");}
     if(state==CaptureRing::Complete && !n) {active=false;uploading=true;upload(pcm,hostRevision);pcm.reset();std::lock_guard<std::mutex> lock(mutex);captureReserved=false;uploading=false;}
     if(state==CaptureRing::Failed || state==CaptureRing::Canceled) {active=false;pcm.reset();std::lock_guard<std::mutex> lock(mutex);captureReserved=false;message=state==CaptureRing::Failed?captureFailure():juce::String("Canceled");}
    }
   } catch(const juce::String& error) {if(active) ring.cancel();std::lock_guard<std::mutex> lock(mutex);if((op=="capture" && !active) || uploading){captureReserved=false;uploading=false;}if((op!="result" || revision==selectionRevision) && (op!="pair" || hostRevision==stateRevision))message="Failed: "+error;}
   if(!active){pollDirect();pollGeneration();}
   wait(10);
  }
 }
};

class BridgeEditor final : public juce::AudioProcessorEditor,private juce::Timer {
 BridgeProcessor& bridge;
 class WorkContent final : public juce::Component {public: juce::Rectangle<int> generationBounds;void paint(juce::Graphics& g) override {g.setColour(juce::Colour(0xff2a2e34));g.fillRoundedRectangle(generationBounds.toFloat(),4);g.setColour(juce::Colour(0xff4c535e));g.drawRoundedRectangle(generationBounds.toFloat().reduced(0.5f),4,1);}};
 class Popup final : public juce::Component {public:void paint(juce::Graphics& g) override {g.setColour(juce::Colour(0xff30363e));g.fillRoundedRectangle(getLocalBounds().toFloat(),5);g.setColour(juce::Colour(0xff75808f));g.drawRoundedRectangle(getLocalBounds().toFloat().reduced(0.5f),5,1);}};
 CatalogLookAndFeel catalogLook;juce::Viewport viewport;WorkContent content;Popup connectionPanel,advancedPanel;
 juce::Label title,statusLabel,durationLabel,durationHint,placementLabel,currentLabel,sourceLabel,referenceLabel,generationStatus,generateTitle,instrumentLabel,promptLabel,connectionTitle,advancedTitle;
 juce::TextEditor code,length,resultId,prompt;
 juce::ComboBox generationMode,instrument;
 juce::TextButton connection{"Connection"},pair{"Pair"},closeConnection{"Close"},capture{"Capture"},cancel{"Cancel"},manualFetch{"Fetch UUID"},advanced{"Advanced"},closeAdvanced{"Close"},reveal{"Reveal in Finder"},generate{"Generate"},cancelGeneration{"Cancel generation"};
 ResultCatalogView catalogView;ResultDragButton drag;std::unique_ptr<juce::TooltipWindow> tooltip;
 bool connectionOpen=false,advancedOpen=false,visibleToCatalog=false;
public:
 explicit BridgeEditor(BridgeProcessor& p):AudioProcessorEditor(p),bridge(p),drag([this]{return bridge.result();}) {
  setLookAndFeel(&catalogLook);catalogLook.setColour(juce::ResizableWindow::backgroundColourId,juce::Colour(0xff202328));catalogLook.setColour(juce::TextEditor::backgroundColourId,juce::Colour(0xff383e47));catalogLook.setColour(juce::TextEditor::textColourId,juce::Colour(0xfff0f2f4));catalogLook.setColour(juce::TextButton::buttonColourId,juce::Colour(0xff383e47));catalogLook.setColour(juce::ComboBox::backgroundColourId,juce::Colour(0xff383e47));catalogLook.setColour(juce::Label::textColourId,juce::Colour(0xfff0f2f4));
  addAndMakeVisible(viewport);viewport.setViewedComponent(&content,false);viewport.setScrollBarsShown(true,false);
  for(auto* c:std::initializer_list<juce::Component*>{&title,&statusLabel,&connection,&currentLabel,&placementLabel,&drag,&reveal,&advanced,&connectionPanel,&advancedPanel})addAndMakeVisible(c);
  for(auto* c:std::initializer_list<juce::Component*>{&durationLabel,&durationHint,&length,&capture,&cancel,&sourceLabel,&referenceLabel,&generateTitle,&generationMode,&instrumentLabel,&instrument,&promptLabel,&prompt,&generationStatus,&generate,&cancelGeneration,&catalogView})content.addAndMakeVisible(c);
  for(auto* c:std::initializer_list<juce::Component*>{&connectionTitle,&code,&pair,&closeConnection})connectionPanel.addAndMakeVisible(c);
  for(auto* c:std::initializer_list<juce::Component*>{&advancedTitle,&resultId,&manualFetch,&closeAdvanced})advancedPanel.addAndMakeVisible(c);
  title.setText("ACE-Step Bridge",juce::dontSendNotification);title.setFont(juce::FontOptions(15.0f,juce::Font::bold));durationLabel.setText("Capture context",juce::dontSendNotification);durationHint.setText("s - 1-120 s",juce::dontSendNotification);durationHint.setFont(juce::FontOptions(11.0f));generateTitle.setText("Generate",juce::dontSendNotification);generateTitle.setFont(juce::FontOptions(14.0f,juce::Font::bold));instrumentLabel.setText("Instrument",juce::dontSendNotification);promptLabel.setText("Prompt",juce::dontSendNotification);connectionTitle.setText("Connection",juce::dontSendNotification);advancedTitle.setText("Advanced",juce::dontSendNotification);
  placementLabel.setName("Suggested start");placementLabel.setTitle("Suggested placement in Logic");placementLabel.setDescription("Seconds from project start. Place the WAV manually in Logic.");placementLabel.setWantsKeyboardFocus(true);
  code.setTextToShowWhenEmpty("One-use pairing code",findColour(juce::Label::textColourId));code.setTitle("Pairing code");code.setName("Pairing code");length.setText(juce::String(bridge.savedSeconds()));length.setTitle("Capture seconds (1 to 120)");length.setName("Capture seconds (1 to 120)");
  resultId.setText(bridge.savedResult());resultId.setTextToShowWhenEmpty("Result UUID",findColour(juce::Label::textColourId));resultId.setTitle("Result UUID");resultId.setName("Result UUID");connection.setName("Connection");advanced.setName("Advanced");
  generationMode.addItem("ACE-Step DAW",1);generationMode.addItem("Direct Cover",2);generationMode.setSelectedId(bridge.layerModeSelected()?1:2,juce::dontSendNotification);generationMode.setTitle("Generation mode");generationMode.setName("Generation mode");generationMode.onChange=[this]{bridge.command("mode",generationMode.getSelectedId()==2?"cover":"layer");layoutContent();timerCallback();};
  instrument.setTitle("Instrument");instrument.setName("Instrument");instrument.onChange=[this]{bridge.command("instrument",instrument.getText());};
  prompt.setMultiLine(true);prompt.setReturnKeyStartsNewLine(true);prompt.setText(bridge.promptText(),false);prompt.setTextToShowWhenEmpty("Describe the instrument and sound",findColour(juce::Label::textColourId));prompt.setTitle("Cover prompt");prompt.setName("Cover prompt");prompt.onTextChange=[this]{bridge.setPromptText(prompt.getText());};
  sourceLabel.setTitle("Captured source");generationStatus.setTitle("Generation status");generationStatus.setName("Generation status");generate.setName("Generate");generate.onClick=[this]{bridge.command(generationMode.getSelectedId()==2?"direct":"generate",prompt.getText());};
  pair.onClick=[this]{bridge.command("pair",code.getText());code.clear();connectionOpen=false;layoutContent();};capture.onClick=[this]{bridge.command("capture",length.getText());};cancel.onClick=[this]{bridge.command("cancel");};cancelGeneration.onClick=[this]{bridge.command("cancel-generation");};manualFetch.onClick=[this]{bridge.command("result",resultId.getText());advancedOpen=false;layoutContent();};
  catalogView.refresh=[this]{bridge.catalogRefresh();};catalogView.older=[this](const std::string& cursor){bridge.catalogOlder(cursor);};catalogView.latest=[this]{bridge.catalogLatest();};catalogView.dismiss=[this]{bridge.catalogDismiss();};catalogView.fetch=[this](const juce::String& id){bridge.command("result",id);};
  connection.onClick=[this]{connectionOpen=!connectionOpen;advancedOpen=false;layoutContent();if(connectionOpen && isShowing())code.grabKeyboardFocus();};closeConnection.onClick=[this]{connectionOpen=false;layoutContent();if(isShowing())connection.grabKeyboardFocus();};advanced.onClick=[this]{advancedOpen=!advancedOpen;connectionOpen=false;layoutContent();if(advancedOpen && isShowing())resultId.grabKeyboardFocus();};closeAdvanced.onClick=[this]{advancedOpen=false;layoutContent();if(isShowing())advanced.grabKeyboardFocus();};reveal.onClick=[this]{bridge.result().revealToUser();};
  tooltip=std::make_unique<juce::TooltipWindow>(this,700);setResizable(true,true);setResizeLimits(440,360,880,720);setSize(640,520);timerCallback();startTimerHz(10);
 }
 bool keyPressed(const juce::KeyPress& key) override {if(key==juce::KeyPress::escapeKey && (connectionOpen || advancedOpen)){const bool wasConnection=connectionOpen;connectionOpen=false;advancedOpen=false;layoutContent();if(isShowing())(wasConnection?static_cast<juce::Component&>(connection):static_cast<juce::Component&>(advanced)).grabKeyboardFocus();return true;}return false;}
 void probeTick(){timerCallback();}
 ~BridgeEditor() override {bridge.catalogVisible(false);setLookAndFeel(nullptr);}
 void visibilityChanged() override {syncVisibility();}
 void timerCallback() override {
  syncVisibility();const bool layer=bridge.layerModeSelected();const int selectedMode=layer?1:2;if(generationMode.getSelectedId()!=selectedMode){generationMode.setSelectedId(selectedMode,juce::dontSendNotification);layoutContent();}auto message=bridge.status();auto direct=bridge.directSnapshot();auto state=bridge.generationSnapshot();
  const auto gs=state.generation;const bool layerBusy=gs==GenerationState::GenerationStatus::checking || gs==GenerationState::GenerationStatus::submitted || gs==GenerationState::GenerationStatus::queued || gs==GenerationState::GenerationStatus::dispatched || gs==GenerationState::GenerationStatus::running || gs==GenerationState::GenerationStatus::exporting || gs==GenerationState::GenerationStatus::cancelPending || gs==GenerationState::GenerationStatus::unknown || state.preparation==GenerationState::PreparationStatus::pending;
  const bool busy=message.startsWith("Armed") || message=="Capturing" || message=="Uploading" || direct.busy || layerBusy;generationMode.setEnabled(!busy);
  statusLabel.setText(state.paired?"Connected":"Not connected",juce::dontSendNotification);statusLabel.setColour(juce::Label::textColourId,state.paired?juce::Colour(0xff98d9ac):juce::Colour(0xfff0c77a));sourceLabel.setText(message,juce::dontSendNotification);
  referenceLabel.setText(state.reference?"Reference: "+juce::String(state.reference->captureId).substring(0,8)+" / "+juce::String(state.reference->preparedRequestId).substring(0,8)+" / "+juce::String(state.reference->durationSeconds,2)+" s":"Reference: unavailable",juce::dontSendNotification);capture.setEnabled(!busy && state.paired);pair.setEnabled(!busy);length.setEnabled(!busy);manualFetch.setEnabled(!busy && state.paired);cancel.setEnabled((message.startsWith("Armed") || message=="Capturing") && !direct.busy && !layerBusy);
  auto old=instrument.getText();juce::StringArray available;for(const auto& value:state.readiness.instruments)available.add(juce::String(value));if(instrument.getNumItems()!=available.size() || [&]{for(int i=0;i<available.size();++i)if(instrument.getItemText(i)!=available[i])return true;return false;}()){instrument.clear(juce::dontSendNotification);for(int i=0;i<available.size();++i)instrument.addItem(available[i],i+1);if(available.contains(old))instrument.setText(old,juce::dontSendNotification);else if(!available.isEmpty())instrument.setSelectedItemIndex(0,juce::dontSendNotification);bridge.command("instrument",instrument.getText());}
  juce::String layerStatus=state.readiness.ready?"Capture ready":juce::String(state.readiness.reason.empty()?"Capture context first":state.readiness.reason);
  if(state.preparation==GenerationState::PreparationStatus::pending)layerStatus=state.preparationDiagnostic.empty()?"Waiting for DAW reference acknowledgement":juce::String(state.preparationDiagnostic);
  else if(state.preparation==GenerationState::PreparationStatus::failed)layerStatus="Preparation failed: "+juce::String(state.preparationError);
  else if(gs==GenerationState::GenerationStatus::failed)layerStatus="Generation failed: "+juce::String(state.error);
  else if(gs==GenerationState::GenerationStatus::ready)layerStatus="Generation ready - fetch from Results";
  else if(gs==GenerationState::GenerationStatus::canceled)layerStatus="Generation canceled";
  else if(gs==GenerationState::GenerationStatus::interrupted)layerStatus="Generation interrupted: "+juce::String(state.error);
  else if(gs==GenerationState::GenerationStatus::unknown)layerStatus=bridge.generationHasActive()?"Outcome unknown; checking status":"Outcome unknown; reconcile in ACE-Step DAW";
  else if(gs==GenerationState::GenerationStatus::cancelPending)layerStatus="Cancel requested";
  else if(gs==GenerationState::GenerationStatus::running || gs==GenerationState::GenerationStatus::dispatched)layerStatus="Generating";
  else if(gs==GenerationState::GenerationStatus::exporting)layerStatus="Exporting result";
  else if(gs==GenerationState::GenerationStatus::queued || gs==GenerationState::GenerationStatus::submitted)layerStatus="Generation queued";
  else if(gs==GenerationState::GenerationStatus::checking)layerStatus="Submitting generation request";
  else if(layerBusy)layerStatus="Preparing or generating";
  if(layer && !busy && state.readiness.ready && state.reference && utf16Units(prompt.getText()).size()>4096)layerStatus="Prompt exceeds 4096 UTF-16 units. Shorten it to generate.";
  const auto statusText=layer?layerStatus:direct.status;generationStatus.setText(statusText,juce::dontSendNotification);generationStatus.setTooltip(statusText);generationStatus.setDescription(statusText);
  generate.setButtonText(layer?"Generate":"Generate Cover");generate.setName(layer?"Generate":"Generate Cover");generate.setEnabled(!busy && (layer?(bridge.generationCanGenerate(instrument.getText(),prompt.getText())):(direct.paired && direct.hasSource && DirectGenerationState::validPrompt(utf16Units(prompt.getText())))));cancelGeneration.setEnabled(layer && (gs==GenerationState::GenerationStatus::submitted || gs==GenerationState::GenerationStatus::queued || gs==GenerationState::GenerationStatus::dispatched || gs==GenerationState::GenerationStatus::running || gs==GenerationState::GenerationStatus::exporting));
  auto snap=bridge.catalogSnapshot();catalogView.update(std::move(snap.page),snap.paired,snap.inFlight,snap.baseline,snap.notice,snap.stale,snap.retrySeconds,busy);
  auto placement=bridge.placement();placementLabel.setText(placement.isEmpty()?"Fetch a result to prepare a WAV.":placement+" - Place manually in Logic",juce::dontSendNotification);bool ready=bridge.result().existsAsFile();currentLabel.setText(ready?"Current WAV: Ready - "+bridge.result().getFileName():"Current WAV: Unavailable",juce::dontSendNotification);drag.setEnabled(ready);reveal.setEnabled(ready);
 }
 void paint(juce::Graphics& g) override {g.fillAll(juce::Colour(0xff202328));g.setColour(juce::Colour(0xff4c535e));g.drawHorizontalLine(getHeight()-88,10.0f,static_cast<float>(getWidth()-10));if(connectionOpen || advancedOpen){auto bounds=connectionOpen?connectionPanel.getBounds():advancedPanel.getBounds();g.setColour(juce::Colour(0xff30363e));g.fillRoundedRectangle(bounds.toFloat(),5);g.setColour(juce::Colour(0xff75808f));g.drawRoundedRectangle(bounds.toFloat(),5,1);}}
 void resized() override {auto b=getLocalBounds().reduced(10);auto header=b.removeFromTop(30);title.setBounds(header.removeFromLeft(160));connection.setBounds(header.removeFromRight(100));statusLabel.setBounds(header.removeFromRight(120));b.removeFromTop(7);auto footer=b.removeFromBottom(78);currentLabel.setBounds(footer.removeFromTop(19));placementLabel.setBounds(footer.removeFromTop(19));auto row=footer.removeFromTop(32);drag.setBounds(row.removeFromLeft(100));row.removeFromLeft(6);reveal.setBounds(row.removeFromLeft(140));advanced.setBounds(row.removeFromRight(100));viewport.setBounds(b);layoutContent();}
private:
 void syncVisibility(){const auto* peer=getPeer();const bool showing=isShowing() && peer!=nullptr && nativeViewIsVisible(peer->getNativeHandle());if(showing!=visibleToCatalog){visibleToCatalog=showing;bridge.catalogVisible(showing);}}
 void layoutContent(){const bool layer=generationMode.getSelectedId()==1;const int width=juce::jmax(1,viewport.getWidth()-viewport.getScrollBarThickness());content.setSize(width,385);auto b=content.getLocalBounds();auto row=b.removeFromTop(30);durationLabel.setBounds(row.removeFromLeft(112));length.setBounds(row.removeFromLeft(48));row.removeFromLeft(5);durationHint.setBounds(row.removeFromLeft(76));capture.setBounds(row.removeFromLeft(76));row.removeFromLeft(5);cancel.setBounds(row.removeFromLeft(72));sourceLabel.setBounds(b.removeFromTop(20));referenceLabel.setBounds(b.removeFromTop(17));b.removeFromTop(5);auto section=b.removeFromTop(142);content.generationBounds=section;auto inner=section.reduced(7);row=inner.removeFromTop(27);generateTitle.setBounds(row.removeFromLeft(72));generationMode.setBounds(row.removeFromLeft(130));if(layer){instrumentLabel.setBounds(row.removeFromLeft(78));instrument.setBounds(row);}instrumentLabel.setVisible(layer);instrument.setVisible(layer);promptLabel.setBounds(inner.removeFromTop(17));prompt.setBounds(inner.removeFromTop(44));inner.removeFromTop(3);row=inner.removeFromTop(30);cancelGeneration.setBounds(row.removeFromRight(130));row.removeFromRight(6);generate.setBounds(row.removeFromRight(100));generationStatus.setBounds(row);b.removeFromTop(5);catalogView.setBounds(b.removeFromTop(166));content.repaint();
  connectionPanel.setVisible(connectionOpen);advancedPanel.setVisible(advancedOpen);auto popup=juce::Rectangle<int>(getWidth()-340,43,330,145);connectionPanel.setBounds(popup);advancedPanel.setBounds(popup);auto panel=connectionPanel.getLocalBounds().reduced(12);connectionTitle.setBounds(panel.removeFromTop(24));code.setBounds(panel.removeFromTop(30));panel.removeFromTop(6);row=panel.removeFromTop(30);pair.setBounds(row.removeFromLeft(100));row.removeFromLeft(6);closeConnection.setBounds(row.removeFromLeft(100));panel=advancedPanel.getLocalBounds().reduced(12);advancedTitle.setBounds(panel.removeFromTop(24));resultId.setBounds(panel.removeFromTop(30));panel.removeFromTop(6);row=panel.removeFromTop(30);manualFetch.setBounds(row.removeFromLeft(110));row.removeFromLeft(6);closeAdvanced.setBounds(row.removeFromLeft(100));connectionPanel.toFront(false);advancedPanel.toFront(false);repaint();}
};
juce::AudioProcessorEditor* BridgeProcessor::createEditor(){return new BridgeEditor(*this);}
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter(){return new BridgeProcessor();}

juce::AudioProcessor* createBridgeProbeProcessor(int port){if(port<1 || port>65535)return nullptr;return new BridgeProcessor(static_cast<unsigned short>(port));}
int bridgeProbePort(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).port();}
void bridgeProbeCommand(juce::AudioProcessor& p,const juce::String& op,const juce::String& arg){static_cast<BridgeProcessor&>(p).command(op,arg);}
juce::String bridgeProbeStatus(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).status();}

juce::File bridgeProbeResult(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).result();}
unsigned bridgeProbeNetworkRequests(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).requestCount();}

juce::String bridgeProbePlacement(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).placement();}

void bridgeProbeCatalogVisible(juce::AudioProcessor& p,bool v){static_cast<BridgeProcessor&>(p).catalogVisible(v);}
juce::String bridgeProbeCatalog(juce::AudioProcessor& p){auto s=static_cast<BridgeProcessor&>(p).catalogSnapshot();juce::String result=(s.stale?juce::String("stale "):juce::String())+"retry="+juce::String(s.retrySeconds)+(s.inFlight?" flight ":" idle ");for(const auto& row:s.page.results)result+=juce::String(row.resultId)+" ";return result+"visible="+juce::String(static_cast<int>(s.visible))+" baseline="+juce::String(static_cast<int>(s.baseline))+" notice="+juce::String(static_cast<int>(s.notice));}
void bridgeProbeCatalogRefresh(juce::AudioProcessor& p){static_cast<BridgeProcessor&>(p).catalogRefresh();}

int bridgeProbeCatalogQos(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).catalogQos();}

void bridgeProbeEditorTick(juce::AudioProcessorEditor& editor){static_cast<BridgeEditor&>(editor).probeTick();}

juce::String bridgeProbeDirect(juce::AudioProcessor& p){auto s=static_cast<BridgeProcessor&>(p).directSnapshot();return s.status+" | "+s.source+(s.busy?" | busy":" | idle");}

void bridgeProbeDirectThenCancel(juce::AudioProcessor& p,const juce::String& prompt){static_cast<BridgeProcessor&>(p).probeDirectThenCancel(prompt);}

juce::String bridgeProbeGeneration(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).generationProbe();}
