#include <juce_audio_utils/juce_audio_utils.h>
#include "../src/NativeVisibility.h"
#import <Cocoa/Cocoa.h>
#include <iostream>
#include <functional>
extern juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();
extern void bridgeProbeCommand(juce::AudioProcessor&,const juce::String&,const juce::String&);
extern juce::String bridgeProbeCatalog(juce::AudioProcessor&);

int main(int argc,char** argv) {
 @autoreleasepool {
  if(argc!=2)return 2;if(nativeViewIsVisible(nullptr)){std::cerr<<"FAIL null native handle\n";return 6;}
  juce::ScopedJuceInitialiser_GUI init;juce::File dir(argv[1]);dir.createDirectory();
  auto count=[&]{return dir.getChildFile("request-count").loadFileAsString().getIntValue();};
  auto pump=[](double seconds){const auto end=juce::Time::getMillisecondCounterHiRes()+seconds*1000;while(juce::Time::getMillisecondCounterHiRes()<end)CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.025,false);};
  auto p=std::unique_ptr<juce::AudioProcessor>(createPluginFilter());auto editor=std::unique_ptr<juce::AudioProcessorEditor>(p->createEditor());juce::Component holder;holder.addAndMakeVisible(*editor);holder.setSize(440,360);
  NSWindow* window=[[NSWindow alloc] initWithContentRect:NSMakeRect(30,30,440,360) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
  [window setReleasedWhenClosed:NO];
  NSView* ancestor=[[NSView alloc] initWithFrame:NSMakeRect(0,0,440,360)];NSView* outer=[[NSView alloc] initWithFrame:NSMakeRect(0,0,440,360)];NSView* host=[[NSView alloc] initWithFrame:NSMakeRect(0,0,440,360)];
  [[window contentView] addSubview:ancestor];[ancestor addSubview:outer];[outer addSubview:host];holder.addToDesktop(0,host);holder.setVisible(true);[window orderFront:nil];pump(0.3);
  auto* peer=holder.getPeer();if(!peer)return 3;NSView* view=(NSView*)peer->getNativeHandle();if(view==nil || [view window]!=window)return 4;
  bridgeProbeCommand(*p,"pair","native-visibility-fixture");
  for(int i=0;i<60 && !bridgeProbeCatalog(*p).contains("baseline=1");++i)pump(.05);
  if(!bridgeProbeCatalog(*p).contains("baseline=1") || count()<1){std::cerr<<"FAIL initial baseline\n";return 5;}
  int failures=0;auto marker=dir.getChildFile("hidden-marker");
  auto scenario=[&](const char* name,const std::function<void()>& hide,const std::function<void()>& show){
   pump(.25);hide();pump(.35);const bool hidden=bridgeProbeCatalog(*p).contains("visible=0 baseline=1");const int before=count();marker.replaceWithText(name);pump(5.8);marker.deleteFile();const int after=count();
   show();pump(.4);bool resumed=bridgeProbeCatalog(*p).contains("visible=1 baseline=1");for(int i=0;i<40 && count()==after;++i)pump(.05);resumed=resumed && count()>after && bridgeProbeCatalog(*p).contains("notice=0");
   std::cout<<name<<" hidden="<<hidden<<" requests_hidden="<<after-before<<" resumed="<<resumed<<" baseline="<<bridgeProbeCatalog(*p)<<std::endl;
   if(!hidden || before!=after || !resumed)++failures;
  };
  scenario("native-peer",[&]{peer->setVisible(false);},[&]{peer->setVisible(true);});
  scenario("window",[&]{[window orderOut:nil];},[&]{[window orderFront:nil];});
  scenario("peer-view",[&]{[view setHidden:YES];},[&]{[view setHidden:NO];});
  scenario("host-view",[&]{[host setHidden:YES];},[&]{[host setHidden:NO];});
  scenario("ancestor",[&]{[ancestor setHidden:YES];},[&]{[ancestor setHidden:NO];});
  scenario("detach",[&]{[host removeFromSuperview];},[&]{[outer addSubview:host];holder.setVisible(true);});
  [window miniaturize:nil];pump(.3);if([window isMiniaturized]){[window deminiaturize:nil];pump(.2);scenario("miniaturized",[&]{[window miniaturize:nil];},[&]{[window deminiaturize:nil];});}else std::cout<<"miniaturized unavailable in fixture environment\n";
  pump(.3);const int beforePeriod=count();pump(1.0);if(count()!=beforePeriod){std::cerr<<"FAIL repeated refresh within 1s\n";++failures;}pump(5.1);const int nextPeriod=count();if(nextPeriod!=beforePeriod+1){std::cerr<<"FAIL normal 5s polling before="<<beforePeriod<<" after="<<nextPeriod<<"\n";++failures;}else std::cout<<"normal polling one request in 6.1s after quiet first second\n";
  holder.removeFromDesktop();pump(.3);if(!bridgeProbeCatalog(*p).contains("visible=0 baseline=1")){std::cerr<<"FAIL peerless\n";++failures;}
  editor.reset();p.reset();[window orderOut:nil];[window close];[host release];[outer release];[ancestor release];[window release];
  std::cout<<"failures="<<failures<<std::endl;return failures?10:0;
 }
}
