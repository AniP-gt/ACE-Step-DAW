#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_cryptography/juce_cryptography.h>
#include <iostream>
#include <cstring>
#include "../src/ResultDragButton.h"
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();
class Playhead final:public juce::AudioPlayHead {
public:
 int64_t frame=0;
 juce::Optional<PositionInfo> getPosition() const override {PositionInfo p;p.setIsPlaying(true);p.setTimeInSamples(frame);p.setBpm(120);p.setTimeSignature(TimeSignature{4,4});return p;}
};
void bridgeProbeCommand(juce::AudioProcessor&,const juce::String&,const juce::String&);
juce::String bridgeProbeStatus(juce::AudioProcessor&);
juce::File bridgeProbeResult(juce::AudioProcessor&);
unsigned bridgeProbeNetworkRequests(juce::AudioProcessor&);
juce::String bridgeProbePlacement(juce::AudioProcessor&);
static bool restoreCache(const juce::File& file,const juce::String& resultId,bool expectReady,const juce::String& overrideName={},const juce::String& expectedPlacement="Suggested start: +0.000000 s") {
 auto* settings=new juce::DynamicObject();settings->setProperty("stateId","offline-fixture");settings->setProperty("captureSeconds",8);settings->setProperty("resultId",resultId);settings->setProperty("cachedFilename",overrideName.isEmpty()?file.getFileName():overrideName);
 juce::MemoryBlock state;{juce::MemoryOutputStream stream(state,false);stream.writeString(juce::JSON::toString(juce::var(settings)));}
 std::unique_ptr<juce::AudioProcessor> restored(createPluginFilter());restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
 for(int i=0;i<500;++i){auto status=bridgeProbeStatus(*restored);if(status.startsWith("Result ready:") || status.startsWith("Cache unavailable:"))break;juce::Thread::sleep(10);}
 auto status=bridgeProbeStatus(*restored);bool valid=expectReady?status.startsWith("Result ready:"):status.startsWith("Cache unavailable:");
 valid=valid && (expectReady?bridgeProbePlacement(*restored)==expectedPlacement:bridgeProbePlacement(*restored).isEmpty()) && bridgeProbeNetworkRequests(*restored)==0 && (expectReady?bridgeProbeResult(*restored)==file:bridgeProbeResult(*restored)==juce::File());
 restored->prepareToPlay(48000,32);juce::AudioBuffer<float> audio(2,32);juce::MidiBuffer midi;for(int c=0;c<2;++c)for(int i=0;i<32;++i)audio.setSample(c,i,.25f);restored->processBlock(audio,midi);for(int c=0;c<2;++c)for(int i=0;i<32;++i)valid=valid && audio.getSample(c,i)==.25f;restored->releaseResources();
 if(!valid)std::cerr<<"Offline restore unexpected status: "<<status<<"\n";
 return valid;
}
static bool offlineCacheChecks() {
 auto directory=juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("ACE-Step Bridge/native-results");directory.createDirectory();auto file=directory.getChildFile(juce::Uuid().toString()+".wav");auto sidecar=file.withFileExtension("json");
 struct Cleanup {juce::File file,sidecar;~Cleanup(){file.deleteFile();sidecar.deleteFile();}} cleanup{file,sidecar};
 juce::WavAudioFormat format;auto output=file.createOutputStream();auto writer=std::unique_ptr<juce::AudioFormatWriter>(format.createWriterFor(output.release(),48000,2,32,{},0));if(!writer)return false;juce::AudioBuffer<float> audio(2,128);audio.clear();audio.setSample(0,17,.5f);audio.setSample(1,17,.5f);if(!writer->writeFromAudioSampleBuffer(audio,0,128))return false;writer.reset();
 auto* metadata=new juce::DynamicObject();auto id=juce::Uuid().toString();metadata->setProperty("resultId",id);metadata->setProperty("placementSeconds",0.0);metadata->setProperty("frameCount",128);metadata->setProperty("sha256",juce::SHA256(file).toHexString());juce::var data(metadata);sidecar.replaceWithText(juce::JSON::toString(data));
 if(!restoreCache(file,id,true))return false;
 metadata->removeProperty("placementSeconds");sidecar.replaceWithText(juce::JSON::toString(data));if(!restoreCache(file,id,false))return false;
 metadata->setProperty("placementSeconds","0");sidecar.replaceWithText(juce::JSON::toString(data));if(!restoreCache(file,id,false))return false;
 sidecar.replaceWithText("{\"resultId\":\""+id+"\",\"frameCount\":128,\"sha256\":\""+juce::SHA256(file).toHexString()+"\",\"placementSeconds\":1e999}");if(!restoreCache(file,id,false))return false;
 metadata->setProperty("placementSeconds",-1.25);sidecar.replaceWithText(juce::JSON::toString(data));if(!restoreCache(file,id,true,{},"Suggested start: -1.250000 s"))return false;
 metadata->setProperty("placementSeconds",0.0);sidecar.replaceWithText(juce::JSON::toString(data));
 sidecar.deleteFile();if(!restoreCache(file,id,false))return false;sidecar.replaceWithText(juce::JSON::toString(data));
 if(!restoreCache(file,"wrong-result-id",false) || !restoreCache(file,id,false,"../escape.wav") || !restoreCache(file,id,false,"..\\escape.wav"))return false;
 metadata->setProperty("frameCount",129);sidecar.replaceWithText(juce::JSON::toString(data));if(!restoreCache(file,id,false))return false;metadata->setProperty("frameCount",128);sidecar.replaceWithText(juce::JSON::toString(data));
 file.replaceWithText("corrupt fixture");if(!restoreCache(file,id,false))return false;file.deleteFile();if(!restoreCache(file,id,false))return false;
 std::cout<<"PASS offline new-processor cache restore; signed placement; missing/nonnumeric/nonfinite placement, mismatched ID/frame count, traversal, corrupt and missing WAV rejected\n";return true;
}
static bool dragGestureChecks() {
 juce::TemporaryFile fixture(".wav");if(!fixture.getFile().replaceWithText("drag gesture fixture"))return false;
 int attempts=0;bool validArguments=true,platformAccepts=true;juce::File available=fixture.getFile();
 ResultDragButton button([&]{return available;},[&](const juce::StringArray& files,bool canMove,juce::Component* source){++attempts;validArguments=validArguments && files.size()==1 && files[0]==fixture.getFile().getFullPathName() && !canMove && source==&button;return platformAccepts;});button.setSize(200,36);
 auto event=[&](float distance,int modifiers){auto now=juce::Time::getCurrentTime();return juce::MouseEvent(juce::Desktop::getInstance().getMainMouseSource(),{10+distance,10},juce::ModifierKeys(modifiers),1,0,0,0,0,&button,&button,now,{10,10},now,1,distance>=5);};
 const int left=juce::ModifierKeys::leftButtonModifier;
 button.mouseDown(event(0,left));button.mouseUp(event(0,0));if(attempts!=0)return false;
 button.mouseDown(event(0,left));button.mouseDrag(event(4,left));if(attempts!=0)return false;
 button.mouseDrag(event(5,left));button.mouseDrag(event(20,left));button.mouseUp(event(20,0));button.mouseDrag(event(30,0));if(attempts!=1)return false;
 button.mouseDown(event(0,left));button.mouseDrag(event(6,left));button.mouseUp(event(6,0));if(attempts!=2)return false;
 available=juce::File();button.mouseDown(event(0,left));button.mouseDrag(event(20,left));button.mouseUp(event(20,0));if(attempts!=2)return false;available=fixture.getFile();
 button.setEnabled(false);button.mouseDown(event(0,left));button.mouseDrag(event(20,left));button.mouseUp(event(20,0));if(attempts!=2)return false;button.setEnabled(true);
 button.mouseDown(event(0,juce::ModifierKeys::rightButtonModifier));button.mouseDrag(event(20,juce::ModifierKeys::rightButtonModifier));button.mouseUp(event(20,0));if(attempts!=2)return false;
 platformAccepts=false;button.mouseDown(event(0,left));button.mouseDrag(event(6,left));button.mouseDrag(event(20,left));button.mouseUp(event(20,0));if(attempts!=3 || !button.getTooltip().contains("Reveal in Finder"))return false;
 if(!validArguments)return false;std::cout<<"PASS drag gesture: no click/subthreshold/missing/disabled/right-button start; one copy-only platform-call per left drag, retry next gesture, Finder fallback on platform refusal\n";return true;
}
int main(int argc,char** argv) {
 juce::ScopedJuceInitialiser_GUI init;
 if(!dragGestureChecks())return 27;
 std::unique_ptr<juce::AudioProcessor> p(createPluginFilter());Playhead head;p->setPlayHead(&head);p->prepareToPlay(48000,512);
 juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
 for(int b=0;b<1000;++b) {for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,static_cast<float>((b+i+c)%101)/101.0f);juce::AudioBuffer<float> before;before.makeCopyOf(audio);p->processBlock(audio,midi);for(int c=0;c<2;++c)if(std::memcmp(audio.getReadPointer(c),before.getReadPointer(c),512*sizeof(float))!=0)return 1;head.frame+=512;}
 if(argc==3 && juce::String(argv[1])=="--snapshot") {
  std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());editor->setVisible(true);editor->resized();juce::Image image(juce::Image::RGB,editor->getWidth(),editor->getHeight(),true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream output{juce::File(argv[2])};if(!output.openedOk())return 6;output.setPosition(0);output.truncate();if(!juce::PNGImageFormat().writeImageToStream(image,output))return 6;
 }
 if(argc==4 && juce::String(argv[1])=="--snapshot-cached") {
  const juce::File cached(argv[2]),outputDirectory(argv[3]);auto metadata=juce::JSON::parse(cached.withFileExtension("json"));
  auto* settings=new juce::DynamicObject();settings->setProperty("stateId","placement-snapshot");settings->setProperty("captureSeconds",8);settings->setProperty("resultId",metadata["resultId"]);settings->setProperty("cachedFilename",cached.getFileName());juce::MemoryBlock state;{juce::MemoryOutputStream stream(state,false);stream.writeString(juce::JSON::toString(juce::var(settings)));}p->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
  for(int i=0;i<500 && !bridgeProbeStatus(*p).startsWith("Result ready:");++i)juce::Thread::sleep(10);
  if(bridgeProbeResult(*p)!=cached || bridgeProbePlacement(*p)!="Suggested start: +0.000000 s" || bridgeProbeNetworkRequests(*p)!=0)return 25;
  outputDirectory.createDirectory();std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());editor->setVisible(true);
  for(auto size:{juce::Point<int>{440,360},juce::Point<int>{880,720}}){editor->setSize(size.x,size.y);editor->resized();juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream output(outputDirectory.getChildFile("restored-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!output.openedOk())return 26;output.setPosition(0);output.truncate();if(!juce::PNGImageFormat().writeImageToStream(image,output))return 26;}
  std::cout<<"PASS restored actual result placement: "<<bridgeProbePlacement(*p)<<"; screenshots 440x360 and 880x720; zero HTTP requests\n";
 }
 if(argc==4 && juce::String(argv[1])=="--race-restore") {
  const juce::File directory(argv[2]);const auto config=juce::JSON::parse(directory.getChildFile("config.json"));
  bridgeProbeCommand(*p,"pair",directory.getChildFile("code").loadFileAsString().trim());
  const bool delayPair=static_cast<bool>(config["delayPair"]);
  if(!delayPair){for(int i=0;i<500 && bridgeProbeStatus(*p)!="Ready";++i)juce::Thread::sleep(10);
  if(bridgeProbeStatus(*p)!="Ready")return 20;
  bridgeProbeCommand(*p,"result",config["resultA"].toString());}
  for(int i=0;i<500 && !directory.getChildFile("response-paused").existsAsFile();++i)juce::Thread::sleep(10);
  if(!directory.getChildFile("response-paused").existsAsFile())return 21;
  auto* settings=new juce::DynamicObject();settings->setProperty("stateId","race-B");settings->setProperty("captureSeconds",8);settings->setProperty("resultId",config["resultB"]);settings->setProperty("cachedFilename",argv[3]);
  juce::MemoryBlock state;{juce::MemoryOutputStream stream(state,false);stream.writeString(juce::JSON::toString(juce::var(settings)));}p->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
  directory.getChildFile("release-response").replaceWithText("release");
  for(int i=0;i<500 && !bridgeProbeStatus(*p).startsWith("Result ready:");++i)juce::Thread::sleep(10);
  juce::Thread::sleep(100);juce::MemoryBlock finalState;p->getStateInformation(finalState);juce::MemoryInputStream stream(finalState,false);auto saved=juce::JSON::parse(stream.readString());
  if(saved["resultId"].toString()!=config["resultB"].toString() || saved["cachedFilename"].toString()!=argv[3] || bridgeProbeResult(*p).getFileName()!=argv[3]){std::cerr<<"FAIL delayed result A overwrote restored state B\n";return 22;}
  bridgeProbeCommand(*p,"result","new-selection");juce::MemoryBlock selectionState;p->getStateInformation(selectionState);juce::MemoryInputStream selectedStream(selectionState,false);auto selected=juce::JSON::parse(selectedStream.readString());
  if(bridgeProbeResult(*p)!=juce::File() || selected["cachedFilename"].toString().isNotEmpty() || selected["resultId"].toString()!="new-selection")return 23;
  bridgeProbeCommand(*p,"capture","1");
  for(int i=0;i<500 && !bridgeProbeStatus(*p).startsWith("Failed: Pair with");++i)juce::Thread::sleep(10);
  if(!bridgeProbeStatus(*p).startsWith("Failed: Pair with")){std::cerr<<"FAIL restored state reused prior credentials\n";return 24;}
  std::cout<<"PASS delayed real HTTP "<<(delayPair?"pairing":"result")<<" A cannot overwrite restored cache B; state load requires re-pair; selection clears prior drag reference\n";
 }
 if(argc==4 && juce::String(argv[1])=="--fetch-result") {
  const juce::File codeFile(argv[2]);
  if(!codeFile.existsAsFile() || codeFile.getSize()>4096){std::cerr<<"Invalid private pairing code file\n";return 10;}
  auto pairingCode=codeFile.loadFileAsString().trim();
  if(pairingCode.isEmpty()){std::cerr<<"Empty pairing code file\n";return 10;}
  bridgeProbeCommand(*p,"pair",pairingCode);pairingCode.clear();
  for(int i=0;i<500;++i){auto status=bridgeProbeStatus(*p);if(status=="Ready" || status.startsWith("Failed:"))break;juce::Thread::sleep(10);}
  if(bridgeProbeStatus(*p)!="Ready"){std::cerr<<bridgeProbeStatus(*p)<<"\n";return 11;}
  bridgeProbeCommand(*p,"result",argv[3]);
  for(int i=0;i<1500;++i){auto status=bridgeProbeStatus(*p);if(status.startsWith("Result ready:") || status.startsWith("Failed:"))break;juce::Thread::sleep(10);}
  const auto status=bridgeProbeStatus(*p);
  if(!status.startsWith("Result ready: ")){std::cerr<<"Result fetch did not complete: "<<status<<"\n";return 12;}
  const auto filename=status.substring(14);
  const auto file=juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("ACE-Step Bridge/native-results").getChildFile(filename);
  auto metadata=juce::JSON::parse(file.withFileExtension("json"));
  juce::WavAudioFormat format;
  auto reader=std::unique_ptr<juce::AudioFormatReader>(format.createReaderFor(file.createInputStream().release(),true));
  const auto hash=juce::SHA256(file).toHexString();
  if(!reader || reader->lengthInSamples<=0 || reader->sampleRate!=48000 || reader->numChannels!=2 || reader->lengthInSamples!=static_cast<juce::int64>(metadata["frameCount"]) || hash!=metadata["sha256"].toString() || metadata["resultId"].toString()!=argv[3]){std::cerr<<"Cached WAV/sidecar validation failed\n";return 13;}
  juce::MemoryBlock persisted;p->getStateInformation(persisted);juce::MemoryInputStream persistedStream(persisted,false);auto persistedData=juce::JSON::parse(persistedStream.readString());
  if(persistedData["cachedFilename"].toString()!=file.getFileName() || persistedData.hasProperty("token") || persistedData.hasProperty("credential"))return 15;
  std::unique_ptr<juce::AudioProcessor> reopened(createPluginFilter());reopened->setStateInformation(persisted.getData(),static_cast<int>(persisted.getSize()));
  for(int i=0;i<500 && !bridgeProbeStatus(*reopened).startsWith("Result ready:");++i)juce::Thread::sleep(10);
  if(bridgeProbeResult(*reopened)!=file || !bridgeProbeResult(*reopened).existsAsFile() || bridgeProbeNetworkRequests(*reopened)!=0 || bridgeProbePlacement(*reopened)!="Suggested start: +0.000000 s"){std::cerr<<"Downloaded result offline reopen failed\n";return 16;}
  std::cout<<"PASS downloaded result actual serialized-state new-processor offline reopen; zero HTTP requests; drag file exists\n";
  std::cout<<"PASS actual native worker: pairing, result HTTP download, SHA256, WAV decode, canonical format and frame count\n"
           <<"file="<<file.getFullPathName()<<"\nsha256="<<hash<<"\nframes="<<reader->lengthInSamples<<"\n";
 }
 if(argc==2) {
  bridgeProbeCommand(*p,"pair",argv[1]);
  for(int i=0;i<500 && bridgeProbeStatus(*p)!="Ready";++i)juce::Thread::sleep(10);
  if(bridgeProbeStatus(*p)!="Ready"){std::cerr<<bridgeProbeStatus(*p)<<"\n";return 2;}
  bridgeProbeCommand(*p,"capture","1");
  for(int i=0;i<100 && !bridgeProbeStatus(*p).startsWith("Armed");++i)juce::Thread::sleep(10);
  head.frame=0;
  for(int b=0;b<94;++b){for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,((head.frame+i)%480==0)?0.75f:0.01f);juce::AudioBuffer<float> before;before.makeCopyOf(audio);p->processBlock(audio,midi);for(int c=0;c<2;++c)if(std::memcmp(audio.getReadPointer(c),before.getReadPointer(c),512*sizeof(float)))return 3;head.frame+=512;juce::Thread::sleep(10);}
  for(int i=0;i<1000 && !bridgeProbeStatus(*p).startsWith("Captured:");++i){if(bridgeProbeStatus(*p).startsWith("Failed:"))break;juce::Thread::sleep(10);}
  std::cout<<bridgeProbeStatus(*p)<<"\n";if(!bridgeProbeStatus(*p).startsWith("Captured:"))return 4;
 }
 if(!offlineCacheChecks())return 14;
 juce::MemoryBlock state;p->getStateInformation(state);p->setStateInformation(state.getData(),static_cast<int>(state.getSize()));juce::MemoryBlock restored;p->getStateInformation(restored);if(state!=restored)return 7;juce::MemoryInputStream stateStream(state,false);auto saved=juce::JSON::parse(stateStream.readString());if(!saved.isObject() || saved.hasProperty("token") || saved.hasProperty("credential") || saved["stateId"].toString().isEmpty())return 8;if(argc==2 && static_cast<int>(saved["captureSeconds"])!=1)return 9;p->releaseResources();
 std::cout<<"PASS actual JUCE processor: 512000 stereo frames bit-identical, state roundtrip, prepare/release\n";
}
