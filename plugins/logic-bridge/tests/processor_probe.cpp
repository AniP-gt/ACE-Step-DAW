#include <juce_audio_utils/juce_audio_utils.h>
#include <iostream>
#include <cstring>
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();
class Playhead final:public juce::AudioPlayHead {
public:
 int64_t frame=0;
 juce::Optional<PositionInfo> getPosition() const override {PositionInfo p;p.setIsPlaying(true);p.setTimeInSamples(frame);p.setBpm(120);p.setTimeSignature(TimeSignature{4,4});return p;}
};
void bridgeProbeCommand(juce::AudioProcessor&,const juce::String&,const juce::String&);
juce::String bridgeProbeStatus(juce::AudioProcessor&);
int main(int argc,char** argv) {
 juce::ScopedJuceInitialiser_GUI init;
 std::unique_ptr<juce::AudioProcessor> p(createPluginFilter());Playhead head;p->setPlayHead(&head);p->prepareToPlay(48000,512);
 juce::AudioBuffer<float> audio(2,512);juce::MidiBuffer midi;
 for(int b=0;b<1000;++b) {for(int c=0;c<2;++c)for(int i=0;i<512;++i)audio.setSample(c,i,static_cast<float>((b+i+c)%101)/101.0f);juce::AudioBuffer<float> before;before.makeCopyOf(audio);p->processBlock(audio,midi);for(int c=0;c<2;++c)if(std::memcmp(audio.getReadPointer(c),before.getReadPointer(c),512*sizeof(float))!=0)return 1;head.frame+=512;}
 if(argc==3 && juce::String(argv[1])=="--snapshot") {
  std::unique_ptr<juce::AudioProcessorEditor> editor(p->createEditor());editor->setVisible(true);editor->resized();juce::Image image(juce::Image::RGB,editor->getWidth(),editor->getHeight(),true);juce::Graphics graphics(image);editor->paintEntireComponent(graphics,true);juce::FileOutputStream output{juce::File(argv[2])};if(!output.openedOk() || !juce::PNGImageFormat().writeImageToStream(image,output))return 6;
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
 juce::MemoryBlock state;p->getStateInformation(state);p->setStateInformation(state.getData(),static_cast<int>(state.getSize()));juce::MemoryBlock restored;p->getStateInformation(restored);if(state!=restored)return 7;juce::MemoryInputStream stateStream(state,false);auto saved=juce::JSON::parse(stateStream.readString());if(!saved.isObject() || saved.hasProperty("token") || saved.hasProperty("credential") || saved["stateId"].toString().isEmpty())return 8;if(argc==2 && static_cast<int>(saved["captureSeconds"])!=1)return 9;p->releaseResources();
 std::cout<<"PASS actual JUCE processor: 512000 stereo frames bit-identical, state roundtrip, prepare/release\n";
}
