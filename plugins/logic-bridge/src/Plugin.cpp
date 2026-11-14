#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_cryptography/juce_cryptography.h>
#include "CaptureRing.h"
#include "ResultDragButton.h"
#include "ResultCatalogClient.h"
#include "ResultCatalogView.h"
#include "NativeVisibility.h"
#include <mutex>
#include <cmath>

class BridgeProcessor final : public juce::AudioProcessor, private juce::Thread {
public:
 BridgeProcessor(): AudioProcessor(BusesProperties().withInput("Input",juce::AudioChannelSet::stereo(),true).withOutput("Output",juce::AudioChannelSet::stereo(),true)), Thread("ACE Bridge worker") { startThread(); catalogThread=std::thread([this]{catalogLoop();}); }
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
 void setStateInformation(const void* data,int bytes) override { juce::MemoryInputStream s(data,static_cast<size_t>(bytes),false);auto saved=juce::JSON::parse(s.readString());if(!saved.isObject())return;std::lock_guard<std::mutex> lock(mutex);stateId=saved["stateId"].toString();sessionDisplay=saved["sessionDisplay"].toString();captureSeconds=juce::jlimit(1,120,static_cast<int>(saved["captureSeconds"]));savedResultId=saved["resultId"].toString();cachedFilename=saved["cachedFilename"].toString();cacheVersion=static_cast<int>(saved["cacheVersion"]);++selectionRevision;++stateRevision;catalog.restore();catalogWake.notify_one();credentialsResetRequested=true;pendingRevision=selectionRevision;pendingStateRevision=stateRevision;localResult=juce::File();placementText.clear();if(pending=="capture")captureReserved=false;pending.clear();argument.clear();if(!cachedFilename.isEmpty()){pending="restore";argument.clear();message="Restoring cached result";}else message="Disconnected"; }
 void command(juce::String op,juce::String arg={}) {std::lock_guard<std::mutex> lock(mutex);if(op=="result" && captureReserved)return;if(op=="capture"){if(captureReserved)return;captureReserved=true;captureSeconds=juce::jlimit(1,120,arg.getIntValue());}else if(pending=="capture")captureReserved=false;if(op=="result"){savedResultId=arg;cachedFilename.clear();cacheVersion=1;localResult=juce::File();placementText.clear();++selectionRevision;message="Fetching result";}pending=op;argument=arg;pendingRevision=selectionRevision;pendingStateRevision=stateRevision;}
 void catalogVisible(bool visible) {std::lock_guard<std::mutex> lock(mutex);catalog.setVisible(visible);if(visible)catalog.refresh();catalogWake.notify_one();}
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
   if(request){lock.unlock();auto page=ResultCatalogClient::fetch(*request,catalogRequestStop);lock.lock();if(page)catalog.succeed(*request,std::move(*page));else catalog.fail(*request);next=std::chrono::steady_clock::now()+std::chrono::seconds(catalog.retrySeconds());continue;}
   if(catalog.visible() && catalog.paired() && next!=std::chrono::steady_clock::time_point::max())catalogWake.wait_until(lock,next);else catalogWake.wait(lock);
  }
 }
 CaptureRing ring;
 std::atomic<double> sampleRate{48000};
 std::mutex mutex;
 juce::String pending,argument,message="Disconnected",token,sessionId,sessionDisplay,savedResultId,cachedFilename;
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
  juce::URL url("http://127.0.0.1:5176/v1"+path);
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
 void upload(const juce::MemoryBlock& pcm) {
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
   show("Captured: "+id);
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
  int code=0;juce::URL url("http://127.0.0.1:5176/v1/assets/"+asset);
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
 void run() override {
  juce::MemoryBlock pcm; std::array<float,8192> scratch{}; bool active=false,uploading=false;
  uint64_t lastHeartbeat=0;double lastActivity=0;
  while(!threadShouldExit()) {
   juce::String op,arg;uint64_t revision=0,hostRevision=0;{std::lock_guard<std::mutex> lock(mutex);if(credentialsResetRequested){token.clear();sessionId.clear();credentialsResetRequested=false;}op=pending;arg=argument;revision=pendingRevision;hostRevision=pendingStateRevision;pending.clear();}
   try {
    if(op=="restore") restoreCachedResult();
    if(op=="pair" && !active) {auto r=request("POST","/pairings/claim",object({{"code",arg}}));if(r["role"].toString()!="native" || r["token"].toString().isEmpty() || r["sessionId"].toString().isEmpty()) throw juce::String("Pairing requires a valid native credential");{std::lock_guard<std::mutex> lock(mutex);if(hostRevision==stateRevision){token=r["token"].toString();sessionId=r["sessionId"].toString();sessionDisplay=sessionId;catalog.pair(sessionId.toStdString(),token.toStdString());catalog.refresh();catalogWake.notify_one();message="Ready";}}}
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
     if(state==CaptureRing::Complete && !n) {active=false;uploading=true;upload(pcm);pcm.reset();std::lock_guard<std::mutex> lock(mutex);captureReserved=false;uploading=false;}
     if(state==CaptureRing::Failed || state==CaptureRing::Canceled) {active=false;pcm.reset();std::lock_guard<std::mutex> lock(mutex);captureReserved=false;message=state==CaptureRing::Failed?captureFailure():juce::String("Canceled");}
    }
   } catch(const juce::String& error) {if(active) ring.cancel();std::lock_guard<std::mutex> lock(mutex);if((op=="capture" && !active) || uploading){captureReserved=false;uploading=false;}if((op!="result" || revision==selectionRevision) && (op!="pair" || hostRevision==stateRevision))message="Failed: "+error;}
   wait(10);
  }
 }
};

class BridgeEditor final : public juce::AudioProcessorEditor,private juce::Timer {
 BridgeProcessor& bridge;
 CatalogLookAndFeel catalogLook;juce::Viewport viewport;juce::Component content;
 juce::Label statusLabel,durationLabel,placementLabel;
 juce::TextEditor code,length,resultId;
 juce::TextButton pair{"Pair"},capture{"Capture"},cancel{"Cancel"},manualFetch{"Fetch UUID"},advanced{"Advanced"},reveal{"Reveal in Finder"};
 ResultCatalogView catalogView;ResultDragButton drag;
 bool advancedOpen=false,visibleToCatalog=false;
public:
 explicit BridgeEditor(BridgeProcessor& p):AudioProcessorEditor(p),bridge(p),drag([this]{return bridge.result();}) {
  setLookAndFeel(&catalogLook);addAndMakeVisible(viewport);viewport.setViewedComponent(&content,false);viewport.setScrollBarsShown(true,false);
  for(auto* c:std::initializer_list<juce::Component*>{&statusLabel,&durationLabel,&placementLabel,&code,&length,&resultId,&pair,&capture,&cancel,&manualFetch,&advanced,&catalogView,&drag,&reveal})content.addAndMakeVisible(c);
  placementLabel.setName("Suggested start");placementLabel.setTitle("Suggested placement in Logic");placementLabel.setDescription("Seconds from project start. Place the WAV manually in Logic.");placementLabel.setEditable(false,false,false);placementLabel.setWantsKeyboardFocus(true);
  code.setTextToShowWhenEmpty("One-use pairing code",findColour(juce::Label::textColourId));code.setTitle("Pairing code");code.setName("Pairing code");
  durationLabel.setText("Seconds",juce::dontSendNotification);length.setText(juce::String(bridge.savedSeconds()));length.setTitle("Capture seconds (1 to 120)");
  resultId.setText(bridge.savedResult());resultId.setTextToShowWhenEmpty("Result UUID",findColour(juce::Label::textColourId));resultId.setTitle("Result UUID");
  pair.onClick=[this]{bridge.command("pair",code.getText());code.clear();};capture.onClick=[this]{bridge.command("capture",length.getText());};cancel.onClick=[this]{bridge.command("cancel");};manualFetch.onClick=[this]{bridge.command("result",resultId.getText());};
  catalogView.refresh=[this]{bridge.catalogRefresh();};catalogView.older=[this](const std::string& cursor){bridge.catalogOlder(cursor);};catalogView.latest=[this]{bridge.catalogLatest();};catalogView.dismiss=[this]{bridge.catalogDismiss();};catalogView.fetch=[this](const juce::String& id){bridge.command("result",id);};
  advanced.onClick=[this]{advancedOpen=!advancedOpen;layoutContent();};reveal.onClick=[this]{bridge.result().revealToUser();};
  setResizable(true,true);setResizeLimits(440,360,880,720);setSize(440,360);timerCallback();startTimerHz(10);
 }
 void probeTick() {timerCallback();}
 ~BridgeEditor() override {bridge.catalogVisible(false);setLookAndFeel(nullptr);}
 void visibilityChanged() override {syncVisibility();}
 void timerCallback() override {syncVisibility();auto s=bridge.status();statusLabel.setText(s,juce::dontSendNotification);bool busy=s.startsWith("Armed")||s=="Capturing"||s=="Uploading";capture.setEnabled(!busy);pair.setEnabled(!busy);length.setEnabled(!busy);manualFetch.setEnabled(!busy);auto snap=bridge.catalogSnapshot();catalogView.update(std::move(snap.page),snap.paired,snap.inFlight,snap.baseline,snap.notice,snap.stale,snap.retrySeconds,busy);auto placement=bridge.placement();placementLabel.setText(placement.isEmpty()?"Suggested start: unavailable":placement,juce::dontSendNotification);bool ready=bridge.result().existsAsFile();drag.setEnabled(ready);reveal.setEnabled(ready);}
 void paint(juce::Graphics& g) override {g.fillAll(getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));}
 void resized() override {viewport.setBounds(getLocalBounds());layoutContent();}
private:
 void syncVisibility(){const auto* peer=getPeer();const bool showing=isShowing() && peer!=nullptr && nativeViewIsVisible(peer->getNativeHandle());if(showing!=visibleToCatalog){visibleToCatalog=showing;bridge.catalogVisible(showing);}}
 void layoutContent() {int width=juce::jmax(1,viewport.getWidth()-viewport.getScrollBarThickness());content.setSize(width,advancedOpen?660:618);auto b=content.getLocalBounds().reduced(16);statusLabel.setBounds(b.removeFromTop(40));auto row=b.removeFromTop(36);pair.setBounds(row.removeFromRight(90));code.setBounds(row.reduced(2));b.removeFromTop(8);row=b.removeFromTop(36);durationLabel.setBounds(row.removeFromLeft(65));length.setBounds(row.removeFromLeft(45));cancel.setBounds(row.removeFromRight(100));capture.setBounds(row.reduced(4,0));b.removeFromTop(12);catalogView.setBounds(b.removeFromTop(290));b.removeFromTop(8);advanced.setBounds(b.removeFromTop(34).removeFromLeft(110));resultId.setVisible(advancedOpen);manualFetch.setVisible(advancedOpen);if(advancedOpen){row=b.removeFromTop(38);manualFetch.setBounds(row.removeFromRight(110).reduced(2));resultId.setBounds(row.reduced(2));}b.removeFromTop(8);row=b.removeFromTop(36);drag.setBounds(row.removeFromLeft(row.getWidth()/2).reduced(2));reveal.setBounds(row.reduced(2));b.removeFromTop(8);placementLabel.setBounds(b.removeFromTop(32));}
};
juce::AudioProcessorEditor* BridgeProcessor::createEditor(){return new BridgeEditor(*this);}
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter(){return new BridgeProcessor();}

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
