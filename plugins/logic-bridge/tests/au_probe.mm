#import <Cocoa/Cocoa.h>
#include <AudioToolbox/AudioToolbox.h>
#include <dlfcn.h>
#include <iostream>
#include <vector>
#include <cmath>
static OSStatus input(void*,AudioUnitRenderActionFlags*,const AudioTimeStamp*,UInt32,UInt32 frames,AudioBufferList* buffers) {
 for(UInt32 c=0;c<buffers->mNumberBuffers;++c) {auto* p=static_cast<float*>(buffers->mBuffers[c].mData);for(UInt32 i=0;i<frames;++i)p[i]=static_cast<float>(i%97)/97.0f;}
 return noErr;
}
int main(int argc,char** argv) {
 if(argc!=2)return 1;
 @autoreleasepool {
 [NSApplication sharedApplication];
 auto* handle=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!handle){std::cerr<<dlerror()<<"\n";return 2;}
 auto factory=reinterpret_cast<AudioComponentFactoryFunction>(dlsym(handle,"ACE_Step_BridgeAUFactory"));if(!factory)return 3;
 AudioComponentDescription d{kAudioUnitType_Effect,'Acbr','Acst',0,0};
 auto component=AudioComponentRegister(&d,CFSTR("ACE-Step Bridge isolated probe"),256,factory);AudioUnit unit=nullptr;
 auto check=[](OSStatus s,const char* stage){if(s){std::cerr<<stage<<": "<<s<<"\n";std::exit(4);}};
 check(AudioComponentInstanceNew(component,&unit),"instantiate");
 AudioStreamBasicDescription format{48000,kAudioFormatLinearPCM,kAudioFormatFlagsNativeFloatPacked|kAudioFormatFlagIsNonInterleaved,4,1,4,2,32,0};
 check(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,0,&format,sizeof(format)),"input format");
 check(AudioUnitSetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,0,&format,sizeof(format)),"output format");
 AURenderCallbackStruct callback{input,nullptr};check(AudioUnitSetProperty(unit,kAudioUnitProperty_SetRenderCallback,kAudioUnitScope_Input,0,&callback,sizeof(callback)),"input callback");
 check(AudioUnitInitialize(unit),"initialize");
 struct StereoBuffers {UInt32 count;AudioBuffer buffer[2];} list{};list.count=2;std::vector<float> left(512),right(512);
 list.buffer[0]={1,2048,left.data()};list.buffer[1]={1,2048,right.data()};
 for(int b=0;b<100;++b){AudioTimeStamp t{};t.mSampleTime=b*512;t.mFlags=kAudioTimeStampSampleTimeValid;AudioUnitRenderActionFlags flags=0;check(AudioUnitRender(unit,&flags,&t,0,512,reinterpret_cast<AudioBufferList*>(&list)),"render");for(int i=0;i<512;++i){auto expected=static_cast<float>(i%97)/97.0f;if(left[i]!=expected || right[i]!=expected)return 5;}}
 check(AudioUnitUninitialize(unit),"uninitialize");check(AudioComponentInstanceDispose(unit),"dispose");
 std::cout<<"PASS local AU binary loaded, initialized, rendered 51200 exact stereo frames, disposed; no system registration\n";
 }
}
