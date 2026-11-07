#include "CaptureRing.h"
#include <cassert>
#include <iostream>
#include <vector>
#include <cstdlib>
#include <new>
static thread_local bool rendering=false;
static int allocations=0;
void* operator new(std::size_t n) {if(rendering)++allocations;if(auto p=std::malloc(n))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept {std::free(p);}
int main() {
 auto r = std::make_unique<CaptureRing>();
 std::vector<float> l(1024,0.25f), rr(1024,-0.5f), out(2048);
 const float* in[]{l.data(),rr.data()};
 r->arm(2048,48000,2);
 r->process(in,1024,{false,false,0,0,0,0},48000,2);
 assert(r->state.load()==CaptureRing::Armed);
 assert(r->drain(out.data(),1024)==0);
 r->process(in,1024,{true,true,1000,120,4,4},48000,2);
 assert(r->drain(out.data(),1024)==1024 && out[0]==.25f && out[1]==-.5f);
 r->process(in,1024,{true,true,2024,120,4,4},48000,2);
 assert(r->state.load()==CaptureRing::Complete);
 assert(l[0]==.25f && rr[0]==-.5f);
 r->reset(); r->arm(48000,48000,2);
 r->process(in,1024,{true,true,0,120,4,4},48000,2);
 r->process(in,1024,{true,true,2000,120,4,4},48000,2);
 assert(r->state.load()==CaptureRing::Failed);
 assert(r->failure.load()==CaptureRing::Failure::PositionDiscontinuity);
 assert(r->expectedSample.load()==1024 && r->observedSample.load()==2000);
 r->reset(); r->arm(500000,48000,2);
 for(int i=0;i<257;++i) r->process(in,1024,{true,true,i*1024,120,4,4},48000,2);
 assert(r->state.load()==CaptureRing::Failed);
 assert(r->failure.load()==CaptureRing::Failure::Overflow);
 for(int rate : {44100,48000,88200,96000}) for(int channels : {1,2}) {
  r->reset();r->arm(static_cast<uint64_t>(rate),rate,channels);int captured=0;
  for(int frame=0;frame<rate;frame+=1024){rendering=true;r->process(in,1024,{true,true,frame,120,4,4},rate,channels);rendering=false;auto n=r->drain(out.data(),1024);captured+=static_cast<int>(n);for(uint64_t i=0;i<n;++i){assert(out[i*channels]==.25f);if(channels==2)assert(out[i*2+1]==-.5f);}}
  assert(captured==rate && r->state.load()==CaptureRing::Complete);
 }
 assert(allocations==0);
 for(int failure=0;failure<4;++failure){r->reset();r->arm(48000,48000,2);r->process(in,1024,{true,true,0,120,4,4},48000,2);auto pos=CaptureRing::Position{true,true,1024,120,4,4};if(failure==0)pos.playing=false;if(failure==1)pos.tempo=121;if(failure==2)pos.numerator=3;if(failure==3)r->cancel();r->process(in,1024,pos,48000,2);assert(r->state.load()==(failure==3?CaptureRing::Canceled:CaptureRing::Failed));}
 r->reset();r->arm(48000,48000,2);
 r->process(in,1024,{false,false,0,0,0,0,0},48000,2);
 assert(r->state.load()==CaptureRing::Armed && r->failure.load()==CaptureRing::Failure::None);
 r->process(in,1024,{true,false,0,0,0,0,1},48000,2);
 assert(r->state.load()==CaptureRing::Failed && r->failure.load()==CaptureRing::Failure::MissingHostPosition && r->missingHostFields.load()==6);
 r->reset();r->arm(48000,48000,2);r->process(in,1024,{true,true,0,120,4,4},44100,2);
 assert(r->failure.load()==CaptureRing::Failure::FormatChanged);
 for(int kind=0;kind<3;++kind){r->reset();r->arm(48000,48000,2);r->process(in,1024,{true,true,0,120,4,4},48000,2);auto pos=CaptureRing::Position{true,true,1024,120,4,4};if(kind==0)pos.playing=false;if(kind==1)pos.tempo=121;if(kind==2)pos.numerator=3;r->process(in,1024,pos,48000,2);const CaptureRing::Failure reasons[]{CaptureRing::Failure::TransportStopped,CaptureRing::Failure::TempoChanged,CaptureRing::Failure::MeterChanged};assert(r->failure.load()==reasons[kind]);}
 r->reset();r->arm(4096,48000,2);
 const int64_t jitteredPositions[]{0,1023,2049,3072};
 uint64_t jitterCaptured=0;
 for(auto position:jitteredPositions){r->process(in,1024,{true,true,position,120,4,4},48000,2);auto n=r->drain(out.data(),1024);jitterCaptured+=n;for(uint64_t i=0;i<n;++i){assert(out[i*2]==.25f && out[i*2+1]==-.5f);}}
 assert(r->state.load()==CaptureRing::Complete && jitterCaptured==4096);
 for(int delta:{-2,2}){r->reset();r->arm(4096,48000,2);r->process(in,1024,{true,true,0,120,4,4},48000,2);r->process(in,1024,{true,true,1024+delta,120,4,4},48000,2);assert(r->state.load()==CaptureRing::Failed && r->failure.load()==CaptureRing::Failure::PositionDiscontinuity);}
 std::cout << "PASS alternating plus/minus one host timestamp jitter preserves 4096 exact frames; plus/minus two rejected\n";
 std::cout << "PASS stopped host without metadata remains Armed, valid playback captures; typed missing-host/format/seek/tempo/meter/overflow/stop diagnostics\n";
 std::cout << "PASS four sample rates x mono/stereo exact length and values; zero render allocations; stop/tempo/meter/cancel\n";
 std::cout << "PASS exact samples, bounded frame stop, seek failure, overflow, unchanged input\n";
}
