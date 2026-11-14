#include "ResultCatalogState.h"
#include <cassert>
#include <iostream>
#include <vector>
using State = ResultCatalogState;
using Page = State::Page;
static Page page(std::initializer_list<unsigned> orders) {
 Page p; for (auto n : orders) p.results.push_back({std::to_string(n), "job", "instrument", 48000, 0., n}); return p;
}
static State::Request begin(State& s) { auto r=s.begin(); assert(r); return *r; }
static void basic() {
 State s; assert(!s.begin()); s.pair("A","key1"); s.setVisible(true); s.refresh(); auto r=begin(s);
 s.refresh(); s.refresh(); assert(!s.begin()); s.succeed(r,page({2,1})); assert(s.baseline() && s.highWater()==2 && !s.notice());
 auto coalesced=begin(s); s.succeed(coalesced,page({1})); assert(s.highWater()==2 && !s.notice());
 s.refresh(); r=begin(s); s.succeed(r,page({3})); assert(s.highWater()==3 && s.notice()); s.dismissNotice();
 s.refresh(); r=begin(s); s.succeed(r,page({})); assert(s.highWater()==3 && !s.notice());
 s.older("cursor"); r=begin(s); s.succeed(r,page({99})); assert(s.highWater()==3 && !s.notice() && s.rows().results[0].publicationOrder==99);
 s.refresh(); r=begin(s); assert(r.beforeResultId.empty()); s.succeed(r,page({4})); assert(s.notice() && s.highWater()==4 && s.rows().results[0].publicationOrder==99);
 s.latest(); r=begin(s); s.succeed(r,page({4})); assert(s.rows().results[0].publicationOrder==4);
 s.dismissNotice(); s.setVisible(false); s.refresh(); assert(!s.begin()); s.setVisible(true); s.refresh(); r=begin(s); s.succeed(r,page({5})); assert(s.notice());
 s.unpair(); s.pair("A","key2"); assert(s.baseline() && s.highWater()==5); s.refresh(); r=begin(s); s.succeed(r,page({6})); assert(s.notice());
 s.pair("B","key3"); assert(!s.baseline() && !s.notice()); s.refresh(); r=begin(s); s.succeed(r,page({})); assert(s.baseline() && s.highWater()==0 && !s.notice());
 s.refresh(); r=begin(s); s.succeed(r,page({1})); assert(s.notice()); s.restore(); assert(!s.baseline() && !s.notice() && !s.begin());
}
static void stale() {
 State s; s.pair("A","a"); s.setVisible(true); s.refresh(); auto old=begin(s); s.pair("B","b"); s.refresh(); s.succeed(old,page({3})); assert(!s.baseline() && s.rows().results.empty()); auto now=begin(s); s.succeed(now,page({1})); assert(s.highWater()==1);
 s.refresh(); old=begin(s); s.pair("B","new-key"); s.refresh(); s.succeed(old,page({3})); assert(s.highWater()==1 && !s.notice()); now=begin(s); s.succeed(now,page({2})); assert(s.notice());
 s.dismissNotice(); s.refresh(); old=begin(s); s.older("cursor"); s.refresh(); s.succeed(old,page({3})); assert(s.highWater()==3 && s.notice() && s.rows().results[0].publicationOrder==2); now=begin(s); s.succeed(now,page({1})); assert(s.rows().results[0].publicationOrder==1);
 s.refresh(); old=begin(s); s.restore(); s.pair("A","a"); s.refresh(); s.succeed(old,page({99})); assert(!s.baseline()); now=begin(s); s.succeed(now,page({1})); assert(!s.notice());
}
static void backoff() {
 State s; s.pair("A","a"); s.setVisible(true); for(int n:{5,10,20,30,30}) {s.refresh(); auto r=begin(s); s.fail(r); assert(s.retrySeconds()==n && s.stale());} s.refresh(); auto r=begin(s); s.succeed(r,page({1})); assert(s.retrySeconds()==5 && !s.stale());
 s.refresh(); r=begin(s); s.setVisible(false); s.fail(r); assert(!s.begin());
 s.setVisible(true); s.refresh(); r=begin(s); s.setVisible(false); s.setVisible(true); s.refresh(); s.succeed(r,page({9})); assert(s.highWater()==1 && !s.notice()); r=begin(s); s.succeed(r,page({2})); assert(s.notice());
}
// Enumerate every valid prefix over two sessions, three results and lifecycle events.
static unsigned long long sequences=0, completions=0;
static void walk(State s,int depth) {
 ++sequences; assert(!s.inFlight() || !s.begin()); if(depth==6)return;
 for(int event=0;event<14;++event) {
  auto t=s; bool valid=true;
  switch(event) {
   case 0:t.setVisible(true);break; case 1:t.setVisible(false);break;
   case 2:t.pair("A","a");break; case 3:t.pair("B","b");break; case 4:t.unpair();break;
   case 5:t.restore();break; case 6:t.refresh();break; case 7:t.older("cursor");break; case 8:t.latest();break;
   case 9: {auto r=t.begin(); if(!r)valid=false; break;}
   case 13: {auto r=t.activeRequest(); if(!r){valid=false;break;} t.fail(*r); break;}
   case 10: case 11: case 12: {auto r=t.activeRequest(); if(!r){valid=false;break;} ++completions; const auto old=t; t.succeed(*r,page({static_cast<unsigned>(event-9)})); if(r->generation!=old.generation()) assert(t.highWater()==old.highWater() && t.baseline()==old.baseline()); break;}
  }
  if(valid)walk(t,depth+1);
 }
}
int main(){basic();stale();backoff();walk(State{},0);std::cout<<"PASS state sequences="<<sequences<<" success completions="<<completions<<" depth<=6 sessions=2 ids=3\n";}
