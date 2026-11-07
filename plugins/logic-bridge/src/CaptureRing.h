#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>

// Single audio producer and single worker consumer. Reset only after producer acknowledgement.
class CaptureRing {
public:
 enum State { Idle, Armed, Capturing, Complete, Failed, Canceled };
 enum class Failure { None, FormatChanged, MissingHostPosition, TransportStopped, PositionDiscontinuity, TempoChanged, MeterChanged, Overflow };
 struct Position { bool playing, valid; int64_t sample; double tempo; int numerator, denominator; unsigned available=7; };
 static constexpr uint64_t capacity = 262144;
 std::atomic<State> state{Idle};
 std::atomic<uint64_t> heartbeat{0};
 std::atomic<Failure> failure{Failure::None};
 std::atomic<unsigned> missingHostFields{0};
 std::atomic<int64_t> expectedSample{0},observedSample{0};
 Position start{};
 uint64_t target=0;
 double rate=0;
 int channels=0;
 void arm(uint64_t frames,double sr,int ch) { target=frames;rate=sr;channels=ch;state.store(Armed,std::memory_order_release); }
 void reset() { read=0;write=0;count=0; failure=Failure::None;missingHostFields=0;state=Idle; }
 void cancel() { cancelRequested.store(true); }
 void process(const float* const* input,int frames,Position p,double sr,int ch) noexcept {
  heartbeat.fetch_add(1,std::memory_order_relaxed);
  if(cancelRequested.exchange(false)) { state=Canceled; return; }
  auto s=state.load(std::memory_order_acquire);
  if(s!=Armed && s!=Capturing) return;
  if(s==Armed && !p.playing) return;
  if(s==Capturing && !p.playing) {fail(Failure::TransportStopped,p);return;}
  if(sr!=rate || ch!=channels) {fail(Failure::FormatChanged,p);return;}
  if(!p.valid) {missingHostFields.store(7u & ~p.available);fail(Failure::MissingHostPosition,p);return;}
  if(s==Armed) { start=p; expected=p.sample; state=Capturing; }
  // Host timestamps may round by one frame; copied frames remain anchored to the first block.
  const auto positionDistance = p.sample >= expected
   ? static_cast<uint64_t>(p.sample)-static_cast<uint64_t>(expected)
   : static_cast<uint64_t>(expected)-static_cast<uint64_t>(p.sample);
  if(positionDistance>1) {fail(Failure::PositionDiscontinuity,p);return;}
  if(p.tempo!=start.tempo) {fail(Failure::TempoChanged,p);return;}
  if(p.numerator!=start.numerator || p.denominator!=start.denominator) {fail(Failure::MeterChanged,p);return;}
  auto n=std::min<uint64_t>(static_cast<uint64_t>(frames),target-count);
  auto w=write.load(std::memory_order_relaxed), r=read.load(std::memory_order_acquire);
  if(n>capacity-(w-r)) {fail(Failure::Overflow,p);return;}
  for(uint64_t i=0;i<n;++i) for(int c=0;c<ch;++c) samples[((w+i)%capacity)*2+static_cast<uint64_t>(c)]=input[c][i];
  count+=n; expected+=frames;
  write.store(w+n,std::memory_order_release);
  if(count==target) state.store(Complete,std::memory_order_release);
 }
 uint64_t drain(float* output,uint64_t maxFrames) {
  auto r=read.load(std::memory_order_relaxed), w=write.load(std::memory_order_acquire);
  auto n=std::min(maxFrames,w-r);
  for(uint64_t i=0;i<n;++i) for(int c=0;c<channels;++c) output[i*static_cast<uint64_t>(channels)+static_cast<uint64_t>(c)]=samples[((r+i)%capacity)*2+static_cast<uint64_t>(c)];
  read.store(r+n,std::memory_order_release); return n;
 }
private:
 void fail(Failure reason,const Position& p) noexcept {expectedSample.store(expected,std::memory_order_relaxed);observedSample.store(p.sample,std::memory_order_relaxed);failure.store(reason,std::memory_order_relaxed);state.store(Failed,std::memory_order_release);}
 std::array<float,capacity*2> samples{};
 std::atomic<uint64_t> read{0},write{0};
 std::atomic<bool> cancelRequested{false};
 uint64_t count=0;
 int64_t expected=0;
};
