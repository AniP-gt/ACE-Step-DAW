#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_cryptography/juce_cryptography.h>
#include "CaptureRing.h"
#include <mutex>

class BridgeProcessor final : public juce::AudioProcessor, private juce::Thread {
public:
 BridgeProcessor(): AudioProcessor(BusesProperties().withInput("Input",juce::AudioChannelSet::stereo(),true).withOutput("Output",juce::AudioChannelSet::stereo(),true)), Thread("ACE Bridge worker") { startThread(); }
 ~BridgeProcessor() override { signalThreadShouldExit(); stopThread(-1); }
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
 void getStateInformation(juce::MemoryBlock& b) override { std::lock_guard<std::mutex> lock(mutex);juce::MemoryOutputStream s(b,false);s.writeString(juce::JSON::toString(object({{"stateId",stateId},{"sessionDisplay",sessionDisplay},{"captureSeconds",captureSeconds},{"resultId",savedResultId}}))); }
 void setStateInformation(const void* data,int bytes) override { juce::MemoryInputStream s(data,static_cast<size_t>(bytes),false);auto saved=juce::JSON::parse(s.readString());if(!saved.isObject())return;std::lock_guard<std::mutex> lock(mutex);stateId=saved["stateId"].toString();sessionDisplay=saved["sessionDisplay"].toString();captureSeconds=juce::jlimit(1,120,static_cast<int>(saved["captureSeconds"]));savedResultId=saved["resultId"].toString(); }
 void command(juce::String op,juce::String arg={}) {std::lock_guard<std::mutex> lock(mutex);if(op=="capture")captureSeconds=juce::jlimit(1,120,arg.getIntValue());if(op=="result")savedResultId=arg;pending=op;argument=arg;}
 juce::String savedResult(){std::lock_guard<std::mutex> lock(mutex);return savedResultId;}
 int savedSeconds(){std::lock_guard<std::mutex> lock(mutex);return captureSeconds;}
 juce::String status() {std::lock_guard<std::mutex> lock(mutex);return message;}
 juce::File result() {std::lock_guard<std::mutex> lock(mutex);return localResult;}
private:
 CaptureRing ring;
 std::atomic<double> sampleRate{48000};
 std::mutex mutex;
 juce::String pending,argument,message="Disconnected",token,sessionId,sessionDisplay,savedResultId;
 int captureSeconds=8;
 juce::String stateId=juce::Uuid().toString(),instanceId=juce::Uuid().toString();
 juce::File localResult;
 void show(juce::String s) {std::lock_guard<std::mutex> lock(mutex);message=s;}
 juce::var request(juce::String method,juce::String path,juce::var body={},const juce::MemoryBlock* binary=nullptr,juce::String extra={}) {
  juce::URL url("http://127.0.0.1:5176/v1"+path);
  if(binary) url=url.withPOSTData(*binary); else if(!body.isVoid()) url=url.withPOSTData(juce::JSON::toString(body));
  int code=0;
  auto headers="X-Bridge-Protocol: 1\r\nAuthorization: Bearer "+token+"\r\nContent-Type: "+(binary?juce::String("application/octet-stream"):juce::String("application/json"))+"\r\n"+extra;
  auto stream=url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress).withHttpRequestCmd(method).withExtraHeaders(headers).withConnectionTimeoutMs(3000).withStatusCode(&code).withNumRedirectsToFollow(0));
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
 void fetchResult(const juce::String& id) {
  auto metadata=request("GET","/results/"+id);
  auto asset=metadata["audioAssetId"].toString(); if(asset.isEmpty()) asset=metadata["assetId"].toString();
  if(asset.isEmpty()) throw juce::String("Result has no audio asset");
  int code=0;juce::URL url("http://127.0.0.1:5176/v1/assets/"+asset);
  auto stream=url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress).withExtraHeaders("Authorization: Bearer "+token+"\r\n").withConnectionTimeoutMs(3000).withStatusCode(&code).withNumRedirectsToFollow(0));
  if(!stream || code!=200) throw juce::String("Result download failed");
  juce::MemoryBlock bytes; constexpr size_t maxBytes=64*1024*1024; std::array<char,65536> block{}; while(!stream->isExhausted()){auto n=stream->read(block.data(),static_cast<int>(block.size()));if(n<=0)break;if(bytes.getSize()+static_cast<size_t>(n)>maxBytes)throw juce::String("Result exceeds 64 MiB limit");bytes.append(block.data(),static_cast<size_t>(n));}
  auto hash=metadata["sha256"].toString(); if(hash.isEmpty() || juce::SHA256(bytes).toHexString()!=hash) throw juce::String("Result hash mismatch");
  juce::WavAudioFormat wav; auto reader=std::unique_ptr<juce::AudioFormatReader>(wav.createReaderFor(new juce::MemoryInputStream(bytes,false),true));
  if(!reader || reader->lengthInSamples<=0 || reader->sampleRate!=48000 || reader->numChannels!=2 || reader->lengthInSamples!=static_cast<juce::int64>(metadata["frameCount"])) throw juce::String("Invalid WAV format or frame count");
  auto dir=juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("ACE-Step Bridge/native-results"); dir.createDirectory();
  auto file=dir.getChildFile(juce::Uuid().toString()+".wav"); if(!file.replaceWithData(bytes.getData(),bytes.getSize())) throw juce::String("Cannot save result");
  file.withFileExtension("json").replaceWithText(juce::JSON::toString(metadata));
  {std::lock_guard<std::mutex> lock(mutex);localResult=file;} show("Result ready: "+file.getFileName());
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
  juce::MemoryBlock pcm; std::array<float,8192> scratch{}; bool active=false;
  uint64_t lastHeartbeat=0;double lastActivity=0;
  while(!threadShouldExit()) {
   juce::String op,arg;{std::lock_guard<std::mutex> lock(mutex);op=pending;arg=argument;pending.clear();}
   try {
    if(op=="pair" && !active) {auto r=request("POST","/pairings/claim",object({{"code",arg}}));if(r["role"].toString()!="native" || r["token"].toString().isEmpty() || r["sessionId"].toString().isEmpty()) throw juce::String("Pairing requires a valid native credential");token=r["token"].toString();sessionId=r["sessionId"].toString();{std::lock_guard<std::mutex> lock(mutex);sessionDisplay=sessionId;}show("Ready");}
    if(op=="result" && !active) fetchResult(arg);
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
     if(state==CaptureRing::Complete && !n) {active=false;upload(pcm);pcm.reset();}
     if(state==CaptureRing::Failed || state==CaptureRing::Canceled) {active=false;pcm.reset();show(state==CaptureRing::Failed?captureFailure():juce::String("Canceled"));}
    }
   } catch(const juce::String& error) {if(active) ring.cancel();show("Failed: "+error);}
   wait(10);
  }
 }
};

class BridgeEditor final : public juce::AudioProcessorEditor,private juce::Timer {
 BridgeProcessor& bridge;
 juce::Label statusLabel,durationLabel;
 juce::TextEditor code,length,resultId;
 juce::TextButton pair{"Pair"},capture{"Capture"},cancel{"Cancel"},fetch{"Fetch result"},drag{"Drag WAV"},reveal{"Reveal in Finder"};
public:
 explicit BridgeEditor(BridgeProcessor& p):AudioProcessorEditor(p),bridge(p) {
  for(auto* c:std::initializer_list<juce::Component*>{&statusLabel,&durationLabel,&code,&length,&resultId,&pair,&capture,&cancel,&fetch,&drag,&reveal}) addAndMakeVisible(c);
  code.setTextToShowWhenEmpty("One-use pairing code",findColour(juce::Label::textColourId));code.setTitle("Pairing code");
  durationLabel.setText("Seconds",juce::dontSendNotification);length.setText(juce::String(bridge.savedSeconds()));length.setTitle("Capture seconds (1 to 120)");
  resultId.setText(bridge.savedResult());resultId.setTextToShowWhenEmpty("Result UUID",findColour(juce::Label::textColourId));resultId.setTitle("Result UUID");
  pair.onClick=[this]{bridge.command("pair",code.getText());code.clear();}; capture.onClick=[this]{bridge.command("capture",length.getText());};cancel.onClick=[this]{bridge.command("cancel");};fetch.onClick=[this]{bridge.command("result",resultId.getText());};
  drag.onClick=[this]{auto f=bridge.result();if(f.existsAsFile())juce::DragAndDropContainer::performExternalDragDropOfFiles({f.getFullPathName()},false,this);};reveal.onClick=[this]{bridge.result().revealToUser();};
  setResizable(true,true);setResizeLimits(440,360,880,720);setSize(440,360);timerCallback();startTimerHz(10);
 }
 void timerCallback() override {auto s=bridge.status();statusLabel.setText(s,juce::dontSendNotification);bool busy=s.startsWith("Armed")||s=="Capturing"||s=="Uploading";capture.setEnabled(!busy);pair.setEnabled(!busy);length.setEnabled(!busy);fetch.setEnabled(!busy);bool ready=bridge.result().existsAsFile();drag.setEnabled(ready);reveal.setEnabled(ready);}
 void paint(juce::Graphics& g) override {g.fillAll(getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));}
 void resized() override {auto b=getLocalBounds().reduced(16);statusLabel.setBounds(b.removeFromTop(48));auto row=b.removeFromTop(36);pair.setBounds(row.removeFromRight(90));code.setBounds(row.reduced(2));b.removeFromTop(12);row=b.removeFromTop(36);durationLabel.setBounds(row.removeFromLeft(65));length.setBounds(row.removeFromLeft(45));cancel.setBounds(row.removeFromRight(100));capture.setBounds(row.reduced(4,0));b.removeFromTop(24);row=b.removeFromTop(36);fetch.setBounds(row.removeFromRight(110));resultId.setBounds(row.reduced(2));b.removeFromTop(12);row=b.removeFromTop(36);drag.setBounds(row.removeFromLeft(row.getWidth()/2).reduced(2));reveal.setBounds(row.reduced(2));}
};
juce::AudioProcessorEditor* BridgeProcessor::createEditor(){return new BridgeEditor(*this);}
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter(){return new BridgeProcessor();}

void bridgeProbeCommand(juce::AudioProcessor& p,const juce::String& op,const juce::String& arg){static_cast<BridgeProcessor&>(p).command(op,arg);}
juce::String bridgeProbeStatus(juce::AudioProcessor& p){return static_cast<BridgeProcessor&>(p).status();}
