#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_cryptography/juce_cryptography.h>
#include <iostream>
#include <cstring>
#include <cmath>
#include <cstdlib>
#if JUCE_MAC
#include <pthread/qos.h>
#include <CoreFoundation/CoreFoundation.h>
#endif
#include "../src/ResultDragButton.h"
#include "../src/ResultCatalogView.h"
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();
juce::AudioProcessor* createBridgeProbeProcessor(int port);
int bridgeProbePort(juce::AudioProcessor&);
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
void bridgeProbeCatalogVisible(juce::AudioProcessor&,bool);
juce::String bridgeProbeCatalog(juce::AudioProcessor&);
void bridgeProbeCatalogRefresh(juce::AudioProcessor&);
int bridgeProbeCatalogQos(juce::AudioProcessor&);
void bridgeProbeEditorTick(juce::AudioProcessorEditor&);
juce::String bridgeProbeDirect(juce::AudioProcessor&);
void bridgeProbeDirectThenCancel(juce::AudioProcessor&,const juce::String&);
juce::String bridgeProbeGeneration(juce::AudioProcessor&);
static bool restoreCache(const juce::File& file,const juce::String& resultId,bool expectReady,const juce::String& overrideName={},const juce::String& expectedPlacement="Suggested start: +0.000000 s") {
 struct OwnedPairs {std::vector<juce::File> files;~OwnedPairs(){for(const auto& owned:files){owned.deleteFile();owned.withFileExtension("json").deleteFile();}}} cleanup;
 auto* settings=new juce::DynamicObject();settings->setProperty("stateId","offline-fixture");settings->setProperty("captureSeconds",8);settings->setProperty("resultId",resultId);settings->setProperty("cachedFilename",overrideName.isEmpty()?file.getFileName():overrideName);
 juce::MemoryBlock state;{juce::MemoryOutputStream stream(state,false);stream.writeString(juce::JSON::toString(juce::var(settings)));}
 std::unique_ptr<juce::AudioProcessor> restored(createPluginFilter());restored->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
 for(int i=0;i<500;++i){auto status=bridgeProbeStatus(*restored);if(status.startsWith("Result ready:") || status.startsWith("Cache unavailable:"))break;juce::Thread::sleep(10);}
 auto status=bridgeProbeStatus(*restored);bool valid=expectReady?status.startsWith("Result ready:"):status.startsWith("Cache unavailable:");
 valid=valid && (expectReady?bridgeProbePlacement(*restored)==expectedPlacement:bridgeProbePlacement(*restored).isEmpty()) && bridgeProbeNetworkRequests(*restored)==0 && (expectReady?bridgeProbeResult(*restored).existsAsFile() && bridgeProbeResult(*restored)!=file && juce::SHA256(bridgeProbeResult(*restored)).toHexString()==juce::SHA256(file).toHexString():bridgeProbeResult(*restored)==juce::File());
 if(expectReady && valid) {
  const auto originalHash=juce::SHA256(file).toHexString();const auto exported=bridgeProbeResult(*restored);
  cleanup.files.push_back(exported);
  juce::MemoryBlock savedState;restored->getStateInformation(savedState);juce::MemoryInputStream savedStream(savedState,false);auto saved=juce::JSON::parse(savedStream.readString());
  if(static_cast<int>(saved["cacheVersion"])!=1)return false;
  auto canonical=file.getParentDirectory().getChildFile("verified-cache").getChildFile(saved["cachedFilename"].toString());cleanup.files.push_back(canonical);
  if(juce::SHA256(canonical).toHexString()!=originalHash || canonical==exported)return false;
  juce::MemoryBlock changed;if(!exported.loadFileAsData(changed) || changed.getSize()<12 || std::memcmp(changed.getData(),"RIFF",4)!=0)return false;
  const unsigned char chunk[]{'J','U','N','K',4,0,0,0,'t','e','s','t'};changed.append(chunk,sizeof(chunk));auto* bytes=static_cast<unsigned char*>(changed.getData());auto riffSize=static_cast<uint32_t>(changed.getSize()-8);for(int i=0;i<4;++i)bytes[4+i]=static_cast<unsigned char>((riffSize>>(i*8))&255);
  if(!exported.replaceWithData(changed.getData(),changed.getSize()))return false;
  const auto modifiedHash=juce::SHA256(exported).toHexString();
  std::unique_ptr<juce::AudioProcessor> reopened(createPluginFilter());reopened->setStateInformation(savedState.getData(),static_cast<int>(savedState.getSize()));
  for(int i=0;i<500;++i){auto next=bridgeProbeStatus(*reopened);if(next.startsWith("Result ready:") || next.startsWith("Cache unavailable:"))break;juce::Thread::sleep(10);}
  auto fresh=bridgeProbeResult(*reopened);if(fresh!=juce::File())cleanup.files.push_back(fresh);
  juce::WavAudioFormat wav;auto alteredReader=std::unique_ptr<juce::AudioFormatReader>(wav.createReaderFor(exported.createInputStream().release(),true));auto freshReader=std::unique_ptr<juce::AudioFormatReader>(wav.createReaderFor(fresh.createInputStream().release(),true));
  if(!alteredReader || !freshReader || alteredReader->lengthInSamples!=128 || freshReader->lengthInSamples!=128)return false;
  juce::AudioBuffer<float> alteredAudio(2,128),freshAudio(2,128);if(!alteredReader->read(&alteredAudio,0,128,0,true,true) || !freshReader->read(&freshAudio,0,128,0,true,true))return false;
  for(int channel=0;channel<2;++channel)if(std::memcmp(alteredAudio.getReadPointer(channel),freshAudio.getReadPointer(channel),128*sizeof(float))!=0)return false;
  if(!bridgeProbeStatus(*reopened).startsWith("Result ready:") || fresh==exported || juce::SHA256(fresh).toHexString()!=originalHash || juce::SHA256(exported).toHexString()!=modifiedHash || juce::SHA256(canonical).toHexString()!=originalHash || juce::SHA256(file).toHexString()!=originalHash || bridgeProbeNetworkRequests(*reopened)!=0){std::cerr<<"FAIL metadata write to handed-out WAV prevented offline reopen: "<<bridgeProbeStatus(*reopened)<<"\n";return false;}
 }
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
 std::cout<<"PASS immutable cache survives writable export RIFF metadata append; fresh copy exact audio, original export preserved; offline signed placement; missing/nonnumeric/nonfinite placement, mismatched ID/frame count, traversal, corrupt and missing WAV rejected\n";return true;
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
 if(argc==4 && juce::String(argv[1])=="--mode-reopen") {
  std::unique_ptr<juce::AudioProcessor> p(createBridgeProbeProcessor(juce::String(argv[2]).getIntValue()));if(!p)return 220;
  Playhead head;p->setPlayHead(&head);p->prepareToPlay(48000,512);juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
  auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};
  auto waitFor=[&](auto condition,int ms){for(int i=0;i<ms/10;++i){if(condition())return true;juce::Thread::sleep(10);}return false;};
  std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());auto* mode=dynamic_cast<juce::ComboBox*>(find(find,*editor,"Generation mode"));if(!mode || mode->getSelectedId()!=1)return 221;
  mode->setSelectedId(2,juce::sendNotificationSync);editor.reset();editor.reset(p->createEditor());mode=dynamic_cast<juce::ComboBox*>(find(find,*editor,"Generation mode"));if(!mode || mode->getSelectedId()!=2){std::cerr<<"reopened mode differs from processor\n";return 222;}
  auto snapshot=[&](const juce::String& name){for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520},juce::Point<int>{880,720}}){editor->setSize(size.x,size.y);editor->resized();bridgeProbeEditorTick(*editor);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream out(juce::File(argv[3]).getChildFile(name+"-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return false;}return true;};
  if(!snapshot("reopened-cover"))return 228;
  juce::MemoryBlock saved;p->getStateInformation(saved);bridgeProbeCommand(*p,"mode","layer");p->setStateInformation(saved.getData(),static_cast<int>(saved.getSize()));bridgeProbeEditorTick(*editor);if(mode->getSelectedId()!=1){std::cerr<<"open editor did not sync after restore\n";return 223;}if(!snapshot("restored-layer"))return 229;
  mode->setSelectedId(2,juce::sendNotificationSync);mode->setSelectedId(1,juce::sendNotificationSync);bridgeProbeCommand(*p,"pair","fixture");if(!waitFor([&]{return bridgeProbeStatus(*p)=="Ready";},5000))return 224;
  bridgeProbeCommand(*p,"capture","1");if(!waitFor([&]{return bridgeProbeStatus(*p).startsWith("Armed");},5000))return 225;
  bridgeProbeEditorTick(*editor);if(mode->isEnabled())return 230;mode->setSelectedId(2,juce::sendNotificationSync);bridgeProbeEditorTick(*editor);if(mode->getSelectedId()!=1){std::cerr<<"busy mode switch was not rejected\n";return 226;}if(!snapshot("busy-layer"))return 231;
  for(int block=0;block<100;++block){for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,.25f);p->processBlock(audio,midi);head.frame+=512;juce::Thread::sleep(10);}
  if(juce::String(argv[1])=="--generation-prepare-uncertain") {
   juce::File dir(argv[3]);if(!waitFor([&]{return dir.getChildFile("uncertain-lookups").existsAsFile();},8000))return 256;
   std::unique_ptr<juce::AudioProcessorEditor> e(p->createEditor());auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};auto* status=dynamic_cast<juce::Label*>(find(find,*e,"Generation status"));auto* generate=dynamic_cast<juce::Button*>(find(find,*e,"Generate"));bridgeProbeEditorTick(*e);
   const juce::String expected="Reference preparation status unknown; checking status. Check ACE-Step DAW before retrying.";if(!status || !generate || generate->isEnabled() || status->getText()!=expected || status->getTooltip()!=expected || status->getDescription()!=expected){std::cerr<<"wrong uncertain status: "<<(status?status->getText():juce::String("missing"))<<"\n";return 257;}
   for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520}}){e->setSize(size.x,size.y);e->resized();bridgeProbeEditorTick(*e);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);e->paintEntireComponent(graphics,true);juce::FileOutputStream out(dir.getChildFile("prepare-unknown-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 262;}
   auto* tooltip=dynamic_cast<juce::TooltipWindow*>(find(find,*e,"tooltip"));if(!tooltip)return 263;e->setSize(440,360);e->resized();tooltip->displayTip({50,230},status->getTooltip());if(!tooltip->isVisible())return 264;juce::Image help(juce::Image::RGB,440,360,true);juce::Graphics helpGraphics(help);e->paintEntireComponent(helpGraphics,true);juce::FileOutputStream helpOut(dir.getChildFile("prepare-unknown-tooltip-440x360.png"));if(!helpOut.openedOk() || !juce::PNGImageFormat().writeImageToStream(help,helpOut))return 265;tooltip->hideTip();
   bridgeProbeCommand(*p,"instrument","piano");bridgeProbeCommand(*p,"generate","must not submit");if(!dir.getChildFile("allow-pending").replaceWithText("allow"))return 258;
   if(!waitFor([&]{bridgeProbeEditorTick(*e);return status->getText()=="Waiting for DAW reference acknowledgement";},6000))return 259;
   if(!dir.getChildFile("allow-prepared").replaceWithText("allow"))return 260;if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("prepared ready");},6000))return 261;bridgeProbeEditorTick(*e);if(status->getText()!="Capture ready")return 266;
   std::cout<<"PASS uncertain prepare, stable owner lookup and late acknowledgement\n";return 0;
  }
  if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("prepared ready");},10000)){std::cerr<<bridgeProbeGeneration(*p)<<"\n";return 227;}
  std::cout<<"PASS mode reopen, restore, busy guard and layer prepare\n";return 0;
 }
 if(argc==4 && juce::String(argv[1])=="--generation-ui") {
  std::unique_ptr<juce::AudioProcessor> p(createBridgeProbeProcessor(juce::String(argv[2]).getIntValue()));if(!p)return 188;
  std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());juce::File directory(argv[3]);directory.createDirectory();
  auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component* {if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};
  auto* idleCancel=dynamic_cast<juce::Button*>(find(find,*editor,"Cancel"));auto* idleGenCancel=dynamic_cast<juce::Button*>(find(find,*editor,"Cancel generation"));if(!idleCancel || !idleGenCancel || idleCancel->isEnabled() || idleGenCancel->isEnabled())return 217;
  auto* viewport=dynamic_cast<juce::Viewport*>(editor->getChildComponent(0));auto* drag=find(find,*editor,"Drag WAV");auto* mode=dynamic_cast<juce::ComboBox*>(find(find,*editor,"Generation mode"));if(!viewport || !drag || !mode || mode->getSelectedId()!=1)return 189;
  for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520},juce::Point<int>{880,720}}){editor->setSize(size.x,size.y);editor->resized();bridgeProbeEditorTick(*editor);if(!editor->getLocalBounds().contains(editor->getLocalArea(drag,drag->getLocalBounds())))return 190;auto original=editor->getLocalArea(drag,drag->getLocalBounds());viewport->setViewPosition(0,10000);if(editor->getLocalArea(drag,drag->getLocalBounds())!=original)return 191;viewport->setViewPosition(0,0);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream out(directory.getChildFile("generation-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 192;}
  editor->setSize(640,520);editor->resized();bridgeProbeEditorTick(*editor);
  auto* fetch=find(find,*editor,"Fetch selected");if(!fetch || !viewport->getViewArea().contains(viewport->getViewedComponent()->getLocalArea(fetch,fetch->getLocalBounds())))return 193;
  auto save=[&](const juce::String& name){juce::Image image(juce::Image::RGB,640,520,true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream out(directory.getChildFile(name+".png"));return out.openedOk() && juce::PNGImageFormat().writeImageToStream(image,out);};
  auto* connection=dynamic_cast<juce::Button*>(find(find,*editor,"Connection"));auto* advanced=dynamic_cast<juce::Button*>(find(find,*editor,"Advanced"));auto* code=find(find,*editor,"Pairing code");auto* result=find(find,*editor,"Result UUID");if(!connection || !advanced || !code || !result)return 194;
  if(!connection->getWantsKeyboardFocus() || !advanced->getWantsKeyboardFocus() || !code->getWantsKeyboardFocus() || !result->getWantsKeyboardFocus())return 216;
  connection->onClick();if(!code->getParentComponent()->isVisible() || !save("generation-connection"))return 195;if(!editor->keyPressed(juce::KeyPress(juce::KeyPress::escapeKey)) || code->getParentComponent()->isVisible())return 196;
  advanced->onClick();if(!result->getParentComponent()->isVisible() || !save("generation-advanced"))return 197;if(!editor->keyPressed(juce::KeyPress(juce::KeyPress::escapeKey)) || result->getParentComponent()->isVisible())return 198;
  std::cout<<"PASS editor sizes, fixed footer, Fetch and disclosure bounds\n";return 0;
 }
 if(argc==4 && (juce::String(argv[1])=="--generation" || juce::String(argv[1])=="--generation-cancel" || juce::String(argv[1])=="--generation-reject" || juce::String(argv[1])=="--generation-prepare-reject" || juce::String(argv[1])=="--generation-prepare-accepted-failed" || juce::String(argv[1])=="--generation-late-pair" || juce::String(argv[1])=="--generation-late-restore" || juce::String(argv[1])=="--generation-unknown" || juce::String(argv[1])=="--generation-job-failed" || juce::String(argv[1])=="--generation-job-failed-object" || juce::String(argv[1]).startsWith("--generation-post-reject-") || juce::String(argv[1])=="--generation-prepare-uncertain" || juce::String(argv[1])=="--generation-prompt-limit" || juce::String(argv[1])=="--generation-prompt-limit-active")) {
  std::unique_ptr<juce::AudioProcessor> p(createBridgeProbeProcessor(juce::String(argv[2]).getIntValue()));if(!p)return 180;
  Playhead head;p->setPlayHead(&head);p->prepareToPlay(48000,512);juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
  auto waitFor=[&](auto condition,int ms){for(int i=0;i<ms/10;++i){if(condition())return true;juce::Thread::sleep(10);}return false;};
  auto stateImage=[&](const juce::String& name){std::unique_ptr<juce::AudioProcessorEditor> e(p->createEditor());bridgeProbeEditorTick(*e);auto findControl=[&](auto&& self,juce::Component& c,const juce::String& target)->juce::Component*{if(c.getName()==target)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,target))return found;return nullptr;};auto* cancel=dynamic_cast<juce::Button*>(findControl(findControl,*e,"Cancel"));auto* cancelGeneration=dynamic_cast<juce::Button*>(findControl(findControl,*e,"Cancel generation"));if(!cancel || !cancelGeneration || cancel->isEnabled()!=(name=="armed" || name=="capturing") || cancelGeneration->isEnabled()!=(name=="generating")){std::cerr<<"Wrong cancellation controls for "<<name<<"\n";return false;}for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520},juce::Point<int>{880,720}}){e->setSize(size.x,size.y);e->resized();bridgeProbeEditorTick(*e);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);e->paintEntireComponent(graphics,true);juce::FileOutputStream output(juce::File(argv[3]).getChildFile(name+"-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!output.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,output))return false;}return true;};
  bridgeProbeCommand(*p,"pair","fixture");if(!waitFor([&]{return bridgeProbeStatus(*p)=="Ready";},5000))return 181;
  bridgeProbeCommand(*p,"capture","1");if(!waitFor([&]{return bridgeProbeStatus(*p).startsWith("Armed");},5000))return 182;if(!stateImage("armed"))return 209;
  for(int block=0;block<100;++block){for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,.25f);p->processBlock(audio,midi);for(int c=0;c<2;++c)for(int i=0;i<512;++i)if(audio.getSample(c,i)!=.25f)return 183;head.frame+=512;if(block==10){if(!waitFor([&]{return bridgeProbeStatus(*p)=="Capturing";},1000) || !stateImage("capturing"))return 218;}juce::Thread::sleep(10);}
  if(juce::String(argv[1])=="--generation-late-pair" || juce::String(argv[1])=="--generation-late-restore") {
   auto marker=juce::File(argv[3]).getChildFile("prepare-started");if(!waitFor([&]{return marker.existsAsFile();},5000))return 206;
   if(juce::String(argv[1])=="--generation-late-pair"){bridgeProbeCommand(*p,"pair","fixture");if(!waitFor([&]{return bridgeProbeStatus(*p)=="Ready";},6000))return 207;}
   else {juce::MemoryBlock saved;p->getStateInformation(saved);p->setStateInformation(saved.getData(),static_cast<int>(saved.getSize()));juce::Thread::sleep(3000);}
   juce::Thread::sleep(1000);const auto state=bridgeProbeGeneration(*p);if(state.contains("reference=fixture-request") || state.contains("prepared ready")){std::cerr<<state<<"\n";return 208;}
   std::cout<<"PASS delayed preparation ignored after pair or restore\n";return 0;
  }
  if(juce::String(argv[1])=="--generation-prepare-uncertain") {
   juce::File dir(argv[3]);if(!waitFor([&]{return dir.getChildFile("uncertain-lookups").existsAsFile();},8000))return 256;
   std::unique_ptr<juce::AudioProcessorEditor> e(p->createEditor());auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};auto* status=dynamic_cast<juce::Label*>(find(find,*e,"Generation status"));auto* generate=dynamic_cast<juce::Button*>(find(find,*e,"Generate"));bridgeProbeEditorTick(*e);
   const juce::String expected="Reference preparation status unknown; checking status. Check ACE-Step DAW before retrying.";if(!status || !generate || generate->isEnabled() || status->getText()!=expected || status->getTooltip()!=expected || status->getDescription()!=expected){std::cerr<<"wrong uncertain status: "<<(status?status->getText():juce::String("missing"))<<"\n";return 257;}
   for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520}}){e->setSize(size.x,size.y);e->resized();bridgeProbeEditorTick(*e);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);e->paintEntireComponent(graphics,true);juce::FileOutputStream out(dir.getChildFile("prepare-unknown-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 262;}
   auto* tooltip=dynamic_cast<juce::TooltipWindow*>(find(find,*e,"tooltip"));if(!tooltip)return 263;e->setSize(440,360);e->resized();tooltip->displayTip({50,230},status->getTooltip());if(!tooltip->isVisible())return 264;juce::Image help(juce::Image::RGB,440,360,true);juce::Graphics helpGraphics(help);e->paintEntireComponent(helpGraphics,true);juce::FileOutputStream helpOut(dir.getChildFile("prepare-unknown-tooltip-440x360.png"));if(!helpOut.openedOk() || !juce::PNGImageFormat().writeImageToStream(help,helpOut))return 265;tooltip->hideTip();
   bridgeProbeCommand(*p,"instrument","piano");bridgeProbeCommand(*p,"generate","must not submit");if(!dir.getChildFile("allow-pending").replaceWithText("allow"))return 258;
   if(!waitFor([&]{bridgeProbeEditorTick(*e);return status->getText()=="Waiting for DAW reference acknowledgement";},6000))return 259;
   if(!dir.getChildFile("allow-prepared").replaceWithText("allow"))return 260;if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("prepared ready");},6000))return 261;bridgeProbeEditorTick(*e);if(status->getText()!="Capture ready")return 266;
   std::cout<<"PASS uncertain prepare, stable owner lookup and late acknowledgement\n";return 0;
  }
  if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("prepared ready");},10000)){std::cerr<<bridgeProbeGeneration(*p)<<"\n";return 184;}
  if(juce::String(argv[1])=="--generation-prompt-limit-active") {
   bridgeProbeCommand(*p,"instrument","piano");bridgeProbeCommand(*p,"generate","valid prompt");if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("generation=5");},10000))return 274;
   std::unique_ptr<juce::AudioProcessorEditor> e(p->createEditor());auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};auto* status=dynamic_cast<juce::Label*>(find(find,*e,"Generation status"));auto* prompt=dynamic_cast<juce::TextEditor*>(find(find,*e,"Cover prompt"));auto* button=dynamic_cast<juce::Button*>(find(find,*e,"Generate"));if(!status || !prompt || !button)return 275;
   const auto longText=juce::String::repeatedString(juce::String::repeatedString("a",63)+"\n",64)+"a";prompt->setText(longText,true);bridgeProbeEditorTick(*e);if(status->getText()!="Generating" || button->isEnabled())return 276;bridgeProbeCommand(*p,"generate",longText);juce::Thread::sleep(500);std::cout<<"PASS active generation status remains primary\n";return 0;
  }
  if(juce::String(argv[1])=="--generation-prompt-limit") {
   juce::File dir(argv[3]);std::unique_ptr<juce::AudioProcessorEditor> e(p->createEditor());auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};auto* status=dynamic_cast<juce::Label*>(find(find,*e,"Generation status"));auto* generate=dynamic_cast<juce::Button*>(find(find,*e,"Generate"));auto* prompt=dynamic_cast<juce::TextEditor*>(find(find,*e,"Cover prompt"));if(!status || !generate || !prompt)return 267;
   const juce::String warning="Prompt exceeds 4096 UTF-16 units. Shorten it to generate.";auto verify=[&](const juce::String& text,bool allowed){prompt->setText(text,true);bridgeProbeEditorTick(*e);if(generate->isEnabled()!=allowed)return false;return allowed?status->getText()=="Capture ready":status->getText()==warning && status->getTooltip()==warning && status->getDescription()==warning;};
   const auto ascii=juce::String::repeatedString(juce::String::repeatedString("a",63)+"\n",64);const auto emoji=juce::String::repeatedString(juce::String::repeatedString(juce::String::charToString(0x1f3b5),31)+"x\n",64);
   if(!verify(ascii,true) || !verify(ascii+"a",false) || !verify(emoji,true) || !verify(emoji+"a",false)){std::cerr<<"prompt boundary mismatch: "<<status->getText()<<"\n";return 268;}
   e->setSize(440,360);e->resized();bridgeProbeEditorTick(*e);auto* tooltip=dynamic_cast<juce::TooltipWindow*>(find(find,*e,"tooltip"));if(!tooltip)return 269;tooltip->displayTip({50,230},status->getTooltip());juce::Image image(juce::Image::RGB,440,360,true);juce::Graphics graphics(image);e->paintEntireComponent(graphics,true);juce::FileOutputStream out(dir.getChildFile("prompt-limit-tooltip-440x360.png"));if(!tooltip->isVisible() || !out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 270;tooltip->hideTip();
   if(!verify("short",true))return 271;bridgeProbeCommand(*p,"capture","1");if(!waitFor([&]{return bridgeProbeStatus(*p).startsWith("Armed");},5000))return 272;prompt->setText(ascii+"a",true);bridgeProbeEditorTick(*e);if(status->getText()==warning || generate->isEnabled())return 273;bridgeProbeCommand(*p,"cancel",{});
   std::cout<<"PASS 4096/4097 UTF-16 prompt reason, tooltip and operation priority\n";return 0;
  }
  {std::unique_ptr<juce::AudioProcessorEditor> readyEditor(p->createEditor());juce::File outDir(argv[3]);for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520},juce::Point<int>{880,720}}){readyEditor->setSize(size.x,size.y);readyEditor->resized();bridgeProbeEditorTick(*readyEditor);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);readyEditor->paintEntireComponent(graphics,true);juce::FileOutputStream out(outDir.getChildFile("generation-ready-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 199;}}
  if(juce::String(argv[1])=="--generation-prepare-reject" || juce::String(argv[1])=="--generation-prepare-accepted-failed" || juce::String(argv[1]).startsWith("--generation-post-reject-")) {
   bridgeProbeCommand(*p,"capture","1");if(!waitFor([&]{return bridgeProbeStatus(*p).startsWith("Armed");},5000))return 202;
   for(int block=0;block<100;++block){for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,.25f);p->processBlock(audio,midi);head.frame+=512;juce::Thread::sleep(10);}
   const auto expectedReference=juce::String(argv[1])=="--generation-prepare-accepted-failed"?juce::String("reference=prep-A01-fixture"):juce::String("reference=fixture-request-1");if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("preparation=3");},10000) || !bridgeProbeGeneration(*p).contains(expectedReference)){std::cerr<<bridgeProbeGeneration(*p)<<"\n";return 203;}
   std::unique_ptr<juce::AudioProcessorEditor> failedEditor(p->createEditor());failedEditor->setSize(640,520);failedEditor->resized();bridgeProbeEditorTick(*failedEditor);
   auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};auto* button=dynamic_cast<juce::Button*>(find(find,*failedEditor,"Generate"));if(!button)return 242;
   if(juce::String(argv[1])=="--generation-prepare-accepted-failed"){if(button->isEnabled())return 243;bridgeProbeCommand(*p,"instrument","piano");bridgeProbeCommand(*p,"generate","must not submit stale reference");juce::Thread::sleep(1200);if(!bridgeProbeGeneration(*p).contains(expectedReference))return 244;}
   else {if(!waitFor([&]{bridgeProbeEditorTick(*failedEditor);return button->isEnabled();},5000))return 245;}
   if(juce::String(argv[1]).startsWith("--generation-post-reject-")) {
    const auto kind=juce::String(argv[1]).fromFirstOccurrenceOf("--generation-post-reject-",false,false);const auto expectedState=kind=="running"?"generation=5":kind=="ready"?"generation=8":kind=="failed"?"generation=9":"generation=12";const auto expectedText=kind=="running"?"Generating":kind=="ready"?"Generation ready":kind=="failed"?"Generation failed: New job recovery cause":"Outcome unknown";
    bridgeProbeCommand(*p,"instrument","piano");bridgeProbeCommand(*p,"generate","after rejected replacement");if(!waitFor([&]{return bridgeProbeGeneration(*p).contains(expectedState);},10000))return 253;bridgeProbeEditorTick(*failedEditor);auto* status=dynamic_cast<juce::Label*>(find(find,*failedEditor,"Generation status"));if(!status || !status->getText().startsWith(expectedText)){std::cerr<<"wrong status: "<<(status?status->getText():juce::String("missing"))<<"\n";return 254;}
    juce::Image image(juce::Image::RGB,640,520,true);juce::Graphics graphics(image);failedEditor->paintEntireComponent(graphics,true);juce::FileOutputStream out(juce::File(argv[3]).getChildFile("post-reject-status.png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 255;std::cout<<"PASS current generation status after rejected preparation\n";return 0;
   }
juce::Image image(juce::Image::RGB,640,520,true);juce::Graphics graphics(image);failedEditor->paintEntireComponent(graphics,true);juce::FileOutputStream out(juce::File(argv[3]).getChildFile("failed-replacement.png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 204;
   std::cout<<(juce::String(argv[1])=="--generation-prepare-accepted-failed"?"PASS accepted prepare failure blocks stale reference\n":"PASS unaccepted prepare rejection preserves reference\n");return 0;
  }
  bridgeProbeCommand(*p,"instrument","piano");bridgeProbeCommand(*p,"generate","fixture prompt");bridgeProbeCommand(*p,"generate","fixture prompt");
  if(juce::String(argv[1])=="--generation-job-failed" || juce::String(argv[1])=="--generation-job-failed-object") {
   const bool object=juce::String(argv[1])=="--generation-job-failed-object";const juce::String reason=object?"Details unavailable; inspect ACE-Step DAW for more information":"Model unavailable; check ACE-Step DAW model configuration and retry";
   if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("generation=9") && bridgeProbeGeneration(*p).contains("error="+reason);},10000)){std::cerr<<bridgeProbeGeneration(*p)<<"\n";return 246;}
   std::unique_ptr<juce::AudioProcessorEditor> e(p->createEditor());auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};auto* status=dynamic_cast<juce::Label*>(find(find,*e,"Generation status"));
   for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520}}){e->setSize(size.x,size.y);e->resized();bridgeProbeEditorTick(*e);const auto full="Generation failed: "+reason;if(!status || status->getText()!=full || status->getTooltip()!=full || status->getDescription()!=full)return 247;juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);e->paintEntireComponent(graphics,true);juce::FileOutputStream out(juce::File(argv[3]).getChildFile("job-failed-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,out))return 248;}
   auto* tooltip=dynamic_cast<juce::TooltipWindow*>(find(find,*e,"tooltip"));if(!tooltip)return 250;e->setSize(440,360);e->resized();bridgeProbeEditorTick(*e);tooltip->displayTip({50,230},status->getTooltip());if(!tooltip->isVisible())return 251;juce::Image help(juce::Image::RGB,440,360,true);juce::Graphics helpGraphics(help);e->paintEntireComponent(helpGraphics,true);juce::FileOutputStream helpOut(juce::File(argv[3]).getChildFile("job-failed-tooltip-440x360.png"));if(!helpOut.openedOk() || !juce::PNGImageFormat().writeImageToStream(help,helpOut))return 252;tooltip->hideTip();
   if(bridgeProbeResult(*p)!=juce::File())return 249;std::cout<<"PASS failed job cause, tooltip and accessibility description\n";return 0;
  }
  if(juce::String(argv[1])=="--generation-reject"){if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("generation=9") && bridgeProbeGeneration(*p).contains("fixture rejection");},10000))return 205;if(!stateImage("generation-failed"))return 210;std::cout<<"PASS definitive generation rejection\n";return 0;}
  if(juce::String(argv[1])=="--generation-cancel"){if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("generation=5");},10000))return 200;if(!stateImage("generating"))return 211;bridgeProbeCommand(*p,"cancel-generation",{});if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("generation=11");},10000))return 201;if(!stateImage("generation-canceled"))return 212;std::cout<<"PASS scoped generation cancellation\n";return 0;}
  if(juce::String(argv[1])=="--generation-unknown" && std::getenv("BRIDGE_PROBE_MODE_UNKNOWN")!=nullptr) {
   if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("generation=12");},5000))return 232;
   juce::Thread::sleep(1000);juce::MemoryBlock state;p->getStateInformation(state);p->setStateInformation(state.getData(),static_cast<int>(state.getSize()));bridgeProbeCommand(*p,"mode","cover");
   std::unique_ptr<juce::AudioProcessorEditor> e(p->createEditor());bridgeProbeEditorTick(*e);auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component*{if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};auto* mode=dynamic_cast<juce::ComboBox*>(find(find,*e,"Generation mode"));
   if(!mode || mode->getSelectedId()!=1 || mode->isEnabled()){std::cerr<<"unknown allowed mode change\n";return 233;}std::cout<<"PASS unknown occupancy rejects internal mode switch\n";return 0;
  }
  if(juce::String(argv[1])=="--generation-unknown"){if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("generation=12");},5000))return 213;if(!stateImage("generation-unknown"))return 214;}
  if(!waitFor([&]{return bridgeProbeGeneration(*p).contains("result=fixture-result");},10000)){std::cerr<<bridgeProbeGeneration(*p)<<"\n";return 185;}
  if(!stateImage("generation-result"))return 215;if(bridgeProbeResult(*p)!=juce::File())return 186;
  juce::MemoryBlock state;p->getStateInformation(state);juce::MemoryInputStream stream(state,false);auto saved=stream.readString();if(saved.contains("fixture-token") || saved.contains("fixture-request"))return 187;
  std::cout<<"PASS generation capture, prepare, readiness, duplicate, job and output isolation\n";return 0;
 }
 if(argc==6 && juce::String(argv[1])=="--direct-limits") {
  std::unique_ptr<juce::AudioProcessor> p(createBridgeProbeProcessor(juce::String(argv[2]).getIntValue()));if(!p)return 234;Playhead head;p->setPlayHead(&head);p->prepareToPlay(48000,512);juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
  auto waitFor=[&](auto condition,int ms){for(int i=0;i<ms/10;++i){if(condition())return true;juce::Thread::sleep(10);}return false;};
  bridgeProbeCommand(*p,"mode","cover");bridgeProbeCommand(*p,"pair","fixture");if(!waitFor([&]{return bridgeProbeStatus(*p)=="Ready";},5000))return 235;bridgeProbeCommand(*p,"capture","1");if(!waitFor([&]{return bridgeProbeStatus(*p).startsWith("Armed");},5000))return 236;
  for(int block=0;block<100;++block){for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,.25f);p->processBlock(audio,midi);head.frame+=512;juce::Thread::sleep(10);}if(!waitFor([&]{return bridgeProbeStatus(*p).startsWith("Captured:");},5000))return 237;
  bridgeProbeCommand(*p,"direct","bounded transport");auto marker=juce::File(argv[3]).getChildFile("limit-started");if(!waitFor([&]{return marker.existsAsFile();},5000))return 241;
  auto baseline=bridgeProbeNetworkRequests(*p);auto start=juce::Time::getMillisecondCounterHiRes();bool observed=false;const auto kind=juce::String(argv[4]);const bool lookup=juce::String(argv[5])=="lookup";const int maxMs=kind=="oversize"?(lookup?2500:1200):kind=="rejected"?1200:6500;
  while(juce::Time::getMillisecondCounterHiRes()-start<maxMs){for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,.25f);p->processBlock(audio,midi);for(int c=0;c<2;++c)for(int i=0;i<512;++i)if(audio.getSample(c,i)!=.25f)return 238;auto status=bridgeProbeDirect(*p);if(kind=="rejected"?status.startsWith("Generation failed:"):(status.startsWith("Outcome unknown;") && (!lookup || bridgeProbeNetworkRequests(*p)>baseline))){observed=true;break;}juce::Thread::sleep(10);}
  auto elapsed=juce::Time::getMillisecondCounterHiRes()-start;if(!observed){std::cerr<<"FAIL timeout, size bound or rejection after "<<elapsed<<" ms: "<<bridgeProbeDirect(*p)<<"\n";return 239;}if(kind!="rejected")bridgeProbeCommand(*p,"direct","duplicate");juce::Thread::sleep(500);if(bridgeProbeResult(*p)!=juce::File())return 240;
  std::cout<<(kind=="rejected"?"PASS definitive rejection by ":"PASS unknown by ")<<elapsed<<" ms, pass-through and no fetched WAV\n";return 0;
 }
 if((argc==4 || argc==5) && juce::String(argv[1])=="--direct-workflow") {
  const juce::String portText(argv[2]);if(portText.isEmpty() || !portText.containsOnly("0123456789"))return 130;
  std::unique_ptr<juce::AudioProcessor> fixture(createBridgeProbeProcessor(portText.getIntValue()));if(!fixture)return 131;
  Playhead head;fixture->setPlayHead(&head);fixture->prepareToPlay(48000,512);juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
  juce::File directory(argv[3]);directory.createDirectory();std::unique_ptr<juce::AudioProcessorEditor> editor(fixture->createEditor());
  auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component* {if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};
  auto click=[&](const juce::String& name){auto* button=dynamic_cast<juce::Button*>(find(find,*editor,name));if(!button || !button->isEnabled())return false;if(button->onClick)button->onClick();return true;};
  auto snapshot=[&](const juce::String& state,bool end=false){for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520},juce::Point<int>{880,720}}){editor->setSize(size.x,size.y);editor->resized();bridgeProbeEditorTick(*editor);if(end)if(auto* vp=dynamic_cast<juce::Viewport*>(editor->getChildComponent(0)))vp->setViewPosition(0,10000);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream out(directory.getChildFile(state+"-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk())return false;out.setPosition(0);out.truncate();if(!juce::PNGImageFormat().writeImageToStream(image,out))return false;}return true;};
  auto waitFor=[&](auto condition,int ms){for(int i=0;i<ms/10;++i){bridgeProbeEditorTick(*editor);if(condition())return true;juce::Thread::sleep(10);}return false;};
  auto* mode=dynamic_cast<juce::ComboBox*>(find(find,*editor,"Generation mode"));if(!mode)return 179;mode->setSelectedId(2,juce::sendNotificationSync);
  if(!snapshot("direct-unpaired"))return 132;
  auto* pairCode=dynamic_cast<juce::TextEditor*>(find(find,*editor,"Pairing code"));if(!pairCode)return 133;pairCode->setText("fixture");if(!click("Pair"))return 134;
  if(!waitFor([&]{return bridgeProbeStatus(*fixture)=="Ready";},5000))return 135;
  auto* duration=dynamic_cast<juce::TextEditor*>(find(find,*editor,"Capture seconds (1 to 120)"));if(!duration)return 136;duration->setText("1");if(!click("Capture"))return 137;
  if(!waitFor([&]{return bridgeProbeStatus(*fixture).startsWith("Armed");},5000))return 138;
  for(int block=0;block<100;++block){for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,0.2f*std::sin(2.0*3.141592653589793*440*(head.frame+i)/48000.0));fixture->processBlock(audio,midi);head.frame+=512;juce::Thread::sleep(10);}
  if(!waitFor([&]{return bridgeProbeStatus(*fixture).startsWith("Captured:");},5000))return 139;
  auto* text=dynamic_cast<juce::TextEditor*>(find(find,*editor,"Cover prompt"));if(!text)return 140;text->setText("solo violin, preserve melody");if(text->onTextChange)text->onTextChange();bridgeProbeEditorTick(*editor);if(!snapshot("direct-prompt"))return 141;
  if(argc==5 && juce::String(argv[4])=="--race")bridgeProbeDirectThenCancel(*fixture,text->getText());else if(!click("Generate Cover"))return 142;bridgeProbeEditorTick(*editor);if(!bridgeProbeDirect(*fixture).contains("busy"))return 143;if(click("Generate Cover"))return 144;
  if(!snapshot("direct-busy"))return 145;
  editor.reset();editor.reset(fixture->createEditor());mode=dynamic_cast<juce::ComboBox*>(find(find,*editor,"Generation mode"));if(!mode)return 179;if(mode->getSelectedId()!=2 || !bridgeProbeDirect(*fixture).contains("busy"))return 146;
  const bool recovery=argc==5 && juce::String(argv[4])=="--recovery";
  if(recovery) {
   if(!waitFor([&]{return bridgeProbeDirect(*fixture).startsWith("Outcome unknown;");},6000))return 162;
   if(!snapshot("recovery-unknown"))return 163;
   juce::Thread::sleep(3500);bridgeProbeEditorTick(*editor);
   if(!bridgeProbeDirect(*fixture).contains("busy") || click("Generate Cover"))return 164;
   if(!directory.getChildFile("operator-reconcile").replaceWithText("operator explicitly reconciled backend"))return 165;
   if(!waitFor([&]{return bridgeProbeDirect(*fixture).startsWith("Generation failed: SUBMISSION_OUTCOME_UNKNOWN");},6000))return 166;
   if(!snapshot("recovery-failed"))return 167;
   if(!click("Generate Cover"))return 168;
  }
  if(!waitFor([&]{return bridgeProbeStatus(*fixture).startsWith("Result ready:");},15000)){std::cerr<<"FAIL direct generation: "<<bridgeProbeStatus(*fixture)<<" / "<<bridgeProbeDirect(*fixture)<<"\n";return 147;}
  const auto original=bridgeProbeResult(*fixture);if(!original.existsAsFile() || bridgeProbePlacement(*fixture)!="Suggested start: +0.000000 s")return 148;
  if(!snapshot("direct-ready"))return 149;
  editor->setSize(440,360);editor->resized();bridgeProbeEditorTick(*editor);
  auto* viewport=dynamic_cast<juce::Viewport*>(editor->getChildComponent(0));auto* drag=dynamic_cast<juce::Button*>(find(find,*editor,"Drag WAV"));
  if(!viewport || !drag || !drag->isEnabled() || !viewport->getViewedComponent())return 159;
  viewport->setViewPosition(0,10000);
  if(!editor->getLocalBounds().contains(editor->getLocalArea(drag,drag->getLocalBounds())))return 160;
  if(!snapshot("direct-drag",true))return 161;viewport->setViewPosition(0,0);
  if(!recovery) {
   text=dynamic_cast<juce::TextEditor*>(find(find,*editor,"Cover prompt"));if(!text)return 150;text->setText("fail fixture");bridgeProbeEditorTick(*editor);if(!click("Generate Cover"))return 151;
   if(!waitFor([&]{return bridgeProbeDirect(*fixture).startsWith("Generation failed:");},10000))return 152;
   if(bridgeProbeResult(*fixture)!=original || !original.existsAsFile())return 153;
   if(!snapshot("direct-failed"))return 154;
   text->setText("bad wav fixture");bridgeProbeEditorTick(*editor);if(!click("Generate Cover"))return 155;
   if(!waitFor([&]{return bridgeProbeStatus(*fixture).contains("WAV download failed");},10000))return 156;
   if(bridgeProbeResult(*fixture)!=original || !original.existsAsFile())return 157;
   if(!snapshot("direct-download-failed"))return 158;
  }
  juce::MemoryBlock state;fixture->getStateInformation(state);juce::MemoryInputStream stream(state,false);auto saved=juce::JSON::parse(stream.readString());auto cached=original.getParentDirectory().getChildFile("verified-cache").getChildFile(saved["cachedFilename"].toString());
  editor.reset();fixture.reset();original.deleteFile();original.withFileExtension("json").deleteFile();cached.deleteFile();cached.withFileExtension("json").deleteFile();
  std::cout<<(recovery?"PASS same-processor interrupted, explicit reconcile, failed, fresh user request and ready WAV\n":"PASS native pair, capture, prompt, duplicate suppression, editor reopen, auto-fetch, placement and failed generation preserving WAV\n");return 0;
 }
 if(argc==2 && juce::String(argv[1])=="--endpoint-self-test") {
  std::unique_ptr<juce::AudioProcessor> production(createPluginFilter());
  std::unique_ptr<juce::AudioProcessor> fixture(createBridgeProbeProcessor(43210));
  if(bridgeProbePort(*production)!=5176 || !fixture || bridgeProbePort(*fixture)!=43210 || createBridgeProbeProcessor(0)!=nullptr || createBridgeProbeProcessor(65536)!=nullptr)return 1;
  std::cout<<"PASS default, injected and invalid endpoint ports\n";return 0;
 }
 if(argc==3 && juce::String(argv[1])=="--endpoint-workflow") {
  const juce::String portText(argv[2]);if(portText.isEmpty() || portText.containsOnly("0123456789")==false || portText.length()>5)return 28;
  std::unique_ptr<juce::AudioProcessor> fixture(createBridgeProbeProcessor(portText.getIntValue()));if(!fixture)return 29;
  Playhead head;fixture->setPlayHead(&head);fixture->prepareToPlay(48000,512);juce::AudioBuffer<float> audio(2,512);audio.clear();juce::MidiBuffer midi;
  bridgeProbeCatalogVisible(*fixture,true);bridgeProbeCommand(*fixture,"pair","fixture");
  for(int i=0;i<500 && bridgeProbeStatus(*fixture)!="Ready";++i)juce::Thread::sleep(10);if(bridgeProbeStatus(*fixture)!="Ready")return 30;
  for(int i=0;i<500 && !bridgeProbeCatalog(*fixture).contains("baseline=1");++i)juce::Thread::sleep(10);if(!bridgeProbeCatalog(*fixture).contains("baseline=1"))return 31;
  bridgeProbeCommand(*fixture,"result","fixture-result");for(int i=0;i<500 && !bridgeProbeStatus(*fixture).startsWith("Result ready:");++i)juce::Thread::sleep(10);if(!bridgeProbeStatus(*fixture).startsWith("Result ready:"))return 32;
  auto exported=bridgeProbeResult(*fixture);juce::MemoryBlock state;fixture->getStateInformation(state);juce::MemoryInputStream stream(state,false);auto saved=juce::JSON::parse(stream.readString());auto cached=exported.getParentDirectory().getChildFile("verified-cache").getChildFile(saved["cachedFilename"].toString());
  struct Cleanup {juce::File exported,cached;~Cleanup(){exported.deleteFile();exported.withFileExtension("json").deleteFile();cached.deleteFile();cached.withFileExtension("json").deleteFile();}} cleanup{exported,cached};
  bridgeProbeCommand(*fixture,"capture","1");for(int i=0;i<500 && !bridgeProbeStatus(*fixture).startsWith("Armed");++i)juce::Thread::sleep(10);if(!bridgeProbeStatus(*fixture).startsWith("Armed"))return 33;
  for(int i=0;i<100;++i){fixture->processBlock(audio,midi);head.frame+=512;juce::Thread::sleep(10);}
  for(int i=0;i<500 && !bridgeProbeStatus(*fixture).startsWith("Captured:");++i)juce::Thread::sleep(10);bool success=bridgeProbeStatus(*fixture).startsWith("Captured:");
  fixture.reset();if(!success)return 34;
  std::cout<<"PASS loopback pairing, catalog, result, asset and capture workflow\n";return 0;
 }
 if(!dragGestureChecks())return 27;
 std::unique_ptr<juce::AudioProcessor> p(createPluginFilter());Playhead head;p->setPlayHead(&head);p->prepareToPlay(48000,512);
 juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
 for(int b=0;b<1000;++b) {for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,static_cast<float>((b+i+c)%101)/101.0f);juce::AudioBuffer<float> before;before.makeCopyOf(audio);p->processBlock(audio,midi);for(int c=0;c<2;++c)if(std::memcmp(audio.getReadPointer(c),before.getReadPointer(c),512*sizeof(float))!=0)return 1;head.frame+=512;}
 if(argc==3 && juce::String(argv[1])=="--startup-cancel") {
#if JUCE_MAC
  juce::File gate(argv[2]);bridgeProbeCommand(*p,"pair","startup-cancel");
  for(int i=0;i<400 && bridgeProbeStatus(*p)!="Ready";++i)juce::Thread::sleep(10);
  if(bridgeProbeStatus(*p)!="Ready"){std::cerr<<"FAIL pairing "<<bridgeProbeStatus(*p)<<"\n";return 110;}
  setenv("ACE_STARTUP_CANCEL_GATE",gate.getFullPathName().toRawUTF8(),1);bridgeProbeCatalogVisible(*p,true);
  auto waitFile=[&](const char* name,int ms){for(int i=0;i<ms/5;++i){if(gate.getChildFile(name).existsAsFile())return true;juce::Thread::sleep(5);}return false;};
  if(!waitFile("entered",4000)){std::cerr<<"FAIL no startup gate\n";gate.getChildFile("release").replaceWithText("release");return 111;}
  auto start=juce::Time::getMillisecondCounterHiRes();std::atomic<bool> done{false};std::thread destroyer([&]{p.reset();done=true;});
  if(!waitFile("cancel",2000)){gate.getChildFile("release").replaceWithText("release");destroyer.join();std::cerr<<"FAIL no cancellation marker\n";return 112;}
  auto released=juce::Time::getMillisecondCounterHiRes();gate.getChildFile("release").replaceWithText("release");destroyer.join();auto ended=juce::Time::getMillisecondCounterHiRes();
  auto cancelLog=gate.getChildFile("cancel").loadFileAsString();juce::Thread::sleep(100);auto after=gate.getChildFile("cancel").loadFileAsString();unsetenv("ACE_STARTUP_CANCEL_GATE");
  juce::StringArray events;events.addLines(cancelLog);events.removeEmptyStrings();
  std::cout<<"startup stop-to-release "<<(released-start)<<" ms; release-to-join "<<(ended-released)<<" ms; stop-to-join "<<(ended-start)<<" ms; cancel count "<<events.size()<<"; post-finish stable "<<(after==cancelLog)<<"\ncancel timestamps (ms):\n"<<cancelLog<<std::flush;
  if(after!=cancelLog){std::cerr<<"FAIL cancellation after completion\n";return 115;}
  if(!done || ended-released>=1000){std::cerr<<"FAIL startup cancellation exceeded 1000 ms\n";return 113;}return 0;
#else
  return 114;
#endif
 }
 if(argc==2 && juce::String(argv[1])=="--busy-view") {
  ResultCatalogView view;ResultCatalogState::Page page;page.results.push_back({"one","job","Piano",48000,0,1});view.update(page,true,false,true,false,false,5,true);
  juce::ListBox* list=nullptr;juce::Button* fetch=nullptr;for(auto* child:view.getChildren()){if(child->getName()=="Results")list=dynamic_cast<juce::ListBox*>(child);if(child->getName()=="Fetch selected")fetch=dynamic_cast<juce::Button*>(child);}
  int calls=0;view.fetch=[&](const juce::String&){++calls;};if(!list || !fetch || fetch->isEnabled())return 90;list->selectRow(0);if(fetch->isEnabled()){std::cerr<<"FAIL busy row re-enabled Fetch\n";return 91;}if(fetch->onClick)fetch->onClick();if(calls)return 97;view.update(page,false,false,true,false,false,5,false);if(fetch->onClick)fetch->onClick();if(calls)return 98;view.update(page,true,false,true,false,false,5,false);if(!fetch->isEnabled())return 99;if(fetch->onClick)fetch->onClick();return calls==1?0:100;
 }
 if(argc==4 && juce::String(argv[1])=="--ui") {
  juce::File directory(argv[2]);const juce::String selectedId(argv[3]);directory.createDirectory();std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());juce::Component holder;holder.addAndMakeVisible(*editor);holder.setSize(440,360);holder.addToDesktop(0);holder.setVisible(true);
  auto find=[&](auto&& self,juce::Component& c,const juce::String& name)->juce::Component* {if(c.getName()==name)return &c;for(auto* child:c.getChildren())if(auto* found=self(self,*child,name))return found;return nullptr;};
  auto click=[&](const juce::String& name){auto* button=dynamic_cast<juce::Button*>(find(find,*editor,name));if(!button || !button->isEnabled())return false;if(button->onClick)button->onClick();return true;};
  auto tick=[&]{bridgeProbeEditorTick(*editor);};
  auto capture=[&](const juce::String& state,bool end=false){for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520},juce::Point<int>{880,720}}){editor->setSize(size.x,size.y);editor->resized();tick();if(end)if(auto* vp=dynamic_cast<juce::Viewport*>(editor->getChildComponent(0)))vp->setViewPosition(0,10000);juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream out(directory.getChildFile(state+"-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!out.openedOk())return false;out.setPosition(0);out.truncate();if(!juce::PNGImageFormat().writeImageToStream(image,out))return false;}return true;};
  if(!capture("unpaired"))return 50;
  bridgeProbeCommand(*p,"pair","ui-fixture");
  auto waitFor=[&](const juce::String& text,int millis){for(int i=0;i<millis/10;++i){tick();if(bridgeProbeCatalog(*p).contains(text))return true;juce::Thread::sleep(10);}return false;};
  if(!waitFor(" idle ",4000))return 51;juce::Thread::sleep(300);tick();if(!capture("empty"))return 52;
  if(!click("Refresh"))return 53;juce::Thread::sleep(100);tick();if(!capture("loading"))return 54;
  if(!waitFor("11111111-1111-4111-8111-111111111111",4000))return 55;tick();if(!capture("ready"))return 56;
  holder.setVisible(false);tick();if(!bridgeProbeCatalog(*p).contains("visible=0 baseline=1"))return 101;auto marker=directory.getChildFile("hidden-marker");if(!marker.replaceWithText("hidden"))return 103;juce::Thread::sleep(5600);tick();marker.deleteFile();holder.setVisible(true);tick();if(!bridgeProbeCatalog(*p).contains("visible=1 baseline=1"))return 102;juce::Thread::sleep(300);tick();
  auto* list=dynamic_cast<juce::ListBox*>(find(find,*editor,"Results"));if(!list || list->getListBoxModel()->getNumRows()!=2 || !list->getListBoxModel()->getNameForRow(1).contains(selectedId))return 57;
  juce::MemoryBlock before,after;p->getStateInformation(before);list->grabKeyboardFocus();
#if JUCE_MAC
  CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.2,false);
#endif
  if(!list->hasKeyboardFocus(true)){std::cerr<<"FAIL list focus unavailable\n";return 88;}list->selectRow(0);if(!capture("focus"))return 89;list->keyPressed(juce::KeyPress(juce::KeyPress::downKey));tick();if(list->getSelectedRow()!=1)return 71;p->getStateInformation(after);if(before!=after)return 58;
  if(!click("Refresh") || !waitFor(" idle ",4000))return 59;tick();if(list->getSelectedRow()!=1)return 60;p->getStateInformation(after);if(before!=after)return 61;
  if(!click("Older") || !waitFor("33333333-3333-4333-8333-333333333333",4000))return 62;tick();p->getStateInformation(after);if(before!=after)return 63;
  if(!click("Latest") || !waitFor("11111111-1111-4111-8111-111111111111",4000))return 64;tick();if(list->getSelectedRow()!=1)return 65;
  if(!click("Dismiss"))return 72;tick();if(!click("Refresh") || !waitFor(" idle ",4000))return 73;tick();auto* dismiss=dynamic_cast<juce::Button*>(find(find,*editor,"Dismiss"));if(!dismiss || dismiss->isVisible())return 74;
  auto* fetchButton=dynamic_cast<juce::Button*>(find(find,*editor,"Fetch selected"));
  if(!fetchButton)return 66;list->grabKeyboardFocus();for(int i=0;i<30 && !fetchButton->hasKeyboardFocus(true);++i){auto* focused=juce::Component::getCurrentlyFocusedComponent();if(!focused)break;focused->moveKeyboardFocusToSibling(true);}
  if(!fetchButton || !fetchButton->hasKeyboardFocus(true) || !fetchButton->isEnabled() || !static_cast<juce::Component*>(fetchButton)->keyPressed(juce::KeyPress(juce::KeyPress::returnKey)))return 66;
  #if JUCE_MAC
  CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.3,false);
#else
  std::cerr<<"UI fixture message pump unavailable on this platform\n";return 77;
#endif
  p->getStateInformation(after);juce::MemoryInputStream state(after.getData(),after.getSize(),false);auto saved=juce::JSON::parse(state.readString());if(saved["resultId"].toString()!=selectedId){std::cerr<<"FAIL keyboard selected="<<selectedId<<" saved="<<saved["resultId"].toString()<<" status="<<bridgeProbeStatus(*p)<<" enabled="<<fetchButton->isEnabled()<<"\n";return 67;}
  for(int i=0;i<400 && !bridgeProbeStatus(*p).startsWith("Result ready:");++i)juce::Thread::sleep(10);
  const auto downloaded=bridgeProbeResult(*p);if(!downloaded.existsAsFile() || bridgeProbePlacement(*p)!="Suggested start: -2.500000 s")return 78;
  const auto hash=juce::SHA256(downloaded).toHexString();p->getStateInformation(before);tick();
  auto* drag=dynamic_cast<juce::Button*>(find(find,*editor,"Drag WAV"));if(!drag || !drag->isEnabled())return 79;
  auto intact=[&]{juce::MemoryBlock current;p->getStateInformation(current);tick();return current==before && bridgeProbeResult(*p)==downloaded && downloaded.existsAsFile() && juce::SHA256(downloaded).toHexString()==hash && bridgeProbePlacement(*p)=="Suggested start: -2.500000 s" && drag->isEnabled();};
  auto priorRequests=bridgeProbeNetworkRequests(*p);bridgeProbeCommand(*p,"pair","slow-pair");for(int i=0;i<100 && bridgeProbeNetworkRequests(*p)==priorRequests;++i)juce::Thread::sleep(10);if(bridgeProbeNetworkRequests(*p)==priorRequests)return 104;
  bridgeProbeCommand(*p,"capture","8");bridgeProbeCommand(*p,"result","must-not-replace");juce::MemoryBlock during;p->getStateInformation(during);if(during!=before || bridgeProbeResult(*p)!=downloaded)return 92;
  for(int i=0;i<200 && !bridgeProbeStatus(*p).startsWith("Armed");++i)juce::Thread::sleep(10);if(!bridgeProbeStatus(*p).startsWith("Armed"))return 93;
  tick();list->selectRow(0);if(fetchButton->isEnabled() || static_cast<juce::Component*>(fetchButton)->keyPressed(juce::KeyPress(juce::KeyPress::returnKey)))return 94;
#if JUCE_MAC
  CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.1,false);
#endif
  p->getStateInformation(during);if(during!=before || bridgeProbeResult(*p)!=downloaded || bridgeProbePlacement(*p)!="Suggested start: -2.500000 s")return 95;
  bridgeProbeCommand(*p,"cancel",{});for(int i=0;i<200 && bridgeProbeStatus(*p)!="Canceled";++i){head.frame+=512;p->processBlock(audio,midi);juce::Thread::sleep(10);}if(bridgeProbeStatus(*p)!="Canceled")return 96;tick();list->selectRow(1);

  if(!click("Older") || !waitFor("33333333-3333-4333-8333-333333333333",4000) || !intact())return 80;
  juce::Thread::sleep(5600);tick();if(!bridgeProbeCatalog(*p).contains("33333333-3333-4333-8333-333333333333") || !intact())return 81;
  if(!click("Latest") || !waitFor("11111111-1111-4111-8111-111111111111",4000) || !intact() || list->getSelectedRow()!=1)return 82;
  if(!click("Refresh"))return 83;juce::Thread::sleep(300);if(!intact() || list->getSelectedRow()!=1)return 84;
  auto* pairing=dynamic_cast<juce::TextEditor*>(find(find,*editor,"Pairing code"));if(!pairing)return 85;pairing->setText("ui-fixture");if(!click("Pair"))return 86;
  juce::Thread::sleep(500);tick();if(dismiss->isVisible() || !intact() || list->getSelectedRow()!=1)return 87;
  if(!click("Advanced"))return 68;tick();auto* viewport=dynamic_cast<juce::Viewport*>(editor->getChildComponent(0));if(!viewport)return 69;viewport->setViewPosition(0,10000);if(!capture("advanced",true))return 70;
  if(!click("Refresh") || !waitFor("stale",4000))return 75;tick();if(!capture("stale") || !intact())return 76;
  std::cout<<"PASS actual editor keyboard Fetch, verified WAV, page/refresh/cache/placement/drag isolation, older background poll and reconnect notice\n";return 0;
 }
 if(argc==2 && juce::String(argv[1])=="--catalog") {
#if JUCE_MAC
  int qos=-1;for(int i=0;i<200 && (qos=bridgeProbeCatalogQos(*p))==-1;++i)juce::Thread::sleep(10);
  if(qos!=QOS_CLASS_BACKGROUND){std::cerr<<"FAIL worker QoS "<<qos<<"\n";return 48;}std::cout<<"PASS worker pthread_get_qos_class_np class="<<qos<<" QOS_CLASS_BACKGROUND="<<QOS_CLASS_BACKGROUND<<"\n";
#endif
  juce::MemoryBlock before,after;
  bridgeProbeCatalogVisible(*p,true);bridgeProbeCommand(*p,"pair","catalog-fixture");
  auto waitFor=[&](const juce::String& needle,int ms){for(int i=0;i<ms/10;++i){if(bridgeProbeCatalog(*p).contains(needle))return true;juce::Thread::sleep(10);}return false;};
  if(!waitFor("fixture-result",4000)){std::cerr<<"FAIL baseline "<<bridgeProbeCatalog(*p)<<"\n";return 30;}
  p->getStateInformation(before);bridgeProbeCatalogRefresh(*p);if(!waitFor("stale",4000)){std::cerr<<"FAIL oversized "<<bridgeProbeCatalog(*p)<<"\n";return 31;}
  bridgeProbeCatalogRefresh(*p);if(!waitFor("retry=10",4000)){std::cerr<<"FAIL malformed "<<bridgeProbeCatalog(*p)<<"\n";return 32;}
  auto start=juce::Time::getMillisecondCounterHiRes();bridgeProbeCatalogRefresh(*p);if(!waitFor("retry=20",7000)){std::cerr<<"FAIL deadline "<<bridgeProbeCatalog(*p)<<"\n";return 33;}auto elapsed=juce::Time::getMillisecondCounterHiRes()-start;
  if(elapsed<4500 || elapsed>6500 || !bridgeProbeCatalog(*p).contains("fixture-result")){std::cerr<<"FAIL deadline elapsed "<<elapsed<<"\n";return 34;}
  p->getStateInformation(after);if(before!=after){std::cerr<<"FAIL persisted state changed\n";return 35;}
  bridgeProbeCatalogRefresh(*p);if(!waitFor(" flight ",1000))return 36;
  for(int i=0;i<20;++i)bridgeProbeCatalogRefresh(*p);
  bridgeProbeCommand(*p,"capture","1");for(int i=0;i<200 && !bridgeProbeStatus(*p).startsWith("Armed");++i)juce::Thread::sleep(10);if(!bridgeProbeStatus(*p).startsWith("Armed"))return 37;
  for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,0.375f);p->processBlock(audio,midi);for(int c=0;c<2;++c)for(int i=0;i<512;++i)if(audio.getSample(c,i)!=0.375f)return 38;
  bridgeProbeCommand(*p,"cancel",{});for(int i=0;i<200 && bridgeProbeStatus(*p)!="Canceled";++i){juce::Thread::sleep(10);head.frame+=512;p->processBlock(audio,midi);}if(bridgeProbeStatus(*p)!="Canceled"){std::cerr<<"FAIL cancel "<<bridgeProbeStatus(*p)<<"\n";return 39;}
  bridgeProbeCommand(*p,"pair","new-session");if(!waitFor("new-result",5000)){std::cerr<<"FAIL re-pair "<<bridgeProbeCatalog(*p)<<"\n";return 40;}
  if(bridgeProbeCatalog(*p).contains("old-late"))return 41;
  bridgeProbeCatalogRefresh(*p);if(!waitFor(" flight ",1000))return 42;bridgeProbeCatalogVisible(*p,false);juce::Thread::sleep(2500);
  if(bridgeProbeCatalog(*p).contains("hidden-late"))return 43;
  std::unique_ptr<juce::AudioProcessor> second(createPluginFilter());bridgeProbeCatalogVisible(*second,true);bridgeProbeCommand(*second,"pair","new-session");bridgeProbeCatalogVisible(*p,true);
  bool concurrent=false;for(int i=0;i<300;++i){if(bridgeProbeCatalog(*p).contains(" flight ") && bridgeProbeCatalog(*second).contains(" flight ")){concurrent=true;break;}juce::Thread::sleep(10);}if(!concurrent)return 44;
  for(int i=0;i<300 && !bridgeProbeCatalog(*second).contains("new-result");++i)juce::Thread::sleep(10);if(!bridgeProbeCatalog(*second).contains("new-result"))return 45;
  bridgeProbeCatalogVisible(*p,false);bridgeProbeCatalogRefresh(*second);for(int i=0;i<100 && !bridgeProbeCatalog(*second).contains(" flight ");++i)juce::Thread::sleep(10);if(!bridgeProbeCatalog(*second).contains(" flight "))return 46;
  auto shutdownStart=juce::Time::getMillisecondCounterHiRes();second.reset();auto shutdownElapsed=juce::Time::getMillisecondCounterHiRes()-shutdownStart;if(shutdownElapsed>1000){std::cerr<<"FAIL shutdown "<<shutdownElapsed<<" ms\n";return 47;}bridgeProbeCatalogVisible(*p,false);std::cout<<"PASS shutdown during request "<<shutdownElapsed<<" ms\n";
  std::cout<<"PASS catalog baseline, 256 KiB cap, malformed response, stalled deadline "<<elapsed<<" ms, retained rows and saved state; capture pass-through, refresh burst, stale pair, hidden reply and simultaneous processors\n";return 0;
 }
 if(argc==3 && juce::String(argv[1])=="--snapshot") {
  std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());editor->setVisible(true);editor->resized();juce::Image image(juce::Image::RGB,editor->getWidth(),editor->getHeight(),true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream output{juce::File(argv[2])};if(!output.openedOk())return 6;output.setPosition(0);output.truncate();if(!juce::PNGImageFormat().writeImageToStream(image,output))return 6;
 }
 if(argc==4 && juce::String(argv[1])=="--snapshot-cached") {
  const juce::File cached(argv[2]),outputDirectory(argv[3]);auto metadata=juce::JSON::parse(cached.withFileExtension("json"));
  auto* settings=new juce::DynamicObject();settings->setProperty("stateId","placement-snapshot");settings->setProperty("captureSeconds",8);settings->setProperty("resultId",metadata["resultId"]);settings->setProperty("cachedFilename",cached.getFileName());juce::MemoryBlock state;{juce::MemoryOutputStream stream(state,false);stream.writeString(juce::JSON::toString(juce::var(settings)));}p->setStateInformation(state.getData(),static_cast<int>(state.getSize()));
  for(int i=0;i<500 && !bridgeProbeStatus(*p).startsWith("Result ready:");++i)juce::Thread::sleep(10);
  if(!bridgeProbeResult(*p).existsAsFile() || juce::SHA256(bridgeProbeResult(*p)).toHexString()!=juce::SHA256(cached).toHexString() || bridgeProbePlacement(*p)!="Suggested start: +0.000000 s" || bridgeProbeNetworkRequests(*p)!=0)return 25;
  outputDirectory.createDirectory();std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());editor->setVisible(true);
  for(auto size:{juce::Point<int>{440,360},juce::Point<int>{640,520},juce::Point<int>{880,720}}){editor->setSize(size.x,size.y);editor->resized();juce::Image image(juce::Image::RGB,size.x,size.y,true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream output(outputDirectory.getChildFile("restored-"+juce::String(size.x)+"x"+juce::String(size.y)+".png"));if(!output.openedOk())return 26;output.setPosition(0);output.truncate();if(!juce::PNGImageFormat().writeImageToStream(image,output))return 26;}
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
  if(saved["resultId"].toString()!=config["resultB"].toString() || static_cast<int>(saved["cacheVersion"])!=1 || !bridgeProbeResult(*p).existsAsFile() || juce::SHA256(bridgeProbeResult(*p)).toHexString()!=juce::SHA256(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("ACE-Step Bridge/native-results").getChildFile(argv[3])).toHexString()){std::cerr<<"FAIL delayed result A overwrote restored state B\n";return 22;}
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
  auto canonical=file.getParentDirectory().getChildFile("verified-cache").getChildFile(persistedData["cachedFilename"].toString());
  if(static_cast<int>(persistedData["cacheVersion"])!=1 || canonical==file || juce::SHA256(canonical).toHexString()!=hash || persistedData.hasProperty("token") || persistedData.hasProperty("credential"))return 15;
  std::unique_ptr<juce::AudioProcessor> reopened(createPluginFilter());reopened->setStateInformation(persisted.getData(),static_cast<int>(persisted.getSize()));
  for(int i=0;i<500 && !bridgeProbeStatus(*reopened).startsWith("Result ready:");++i)juce::Thread::sleep(10);
  if(bridgeProbeResult(*reopened)==file || !bridgeProbeResult(*reopened).existsAsFile() || juce::SHA256(bridgeProbeResult(*reopened)).toHexString()!=hash || bridgeProbeNetworkRequests(*reopened)!=0 || bridgeProbePlacement(*reopened)!="Suggested start: +0.000000 s"){std::cerr<<"Downloaded result offline reopen failed\n";return 16;}
  std::cout<<"PASS downloaded result actual serialized-state new-processor offline reopen; zero HTTP requests; drag file exists\n";
  std::cout<<"PASS actual native worker: pairing, result HTTP download, SHA256, WAV decode, canonical format and frame count\n"
           <<"file="<<file.getFullPathName()<<"\ncanonical="<<canonical.getFullPathName()<<"\nreopenedExport="<<bridgeProbeResult(*reopened).getFullPathName()<<"\nsha256="<<hash<<"\nframes="<<reader->lengthInSamples<<"\n";
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
