#include "GenerationState.h"
#include <cassert>
#include <iostream>
using S = GenerationState;
static void ready(S& s) {
 s.pair("session"); auto p=s.beginPrepare("prep-1","capture-1",8); assert(p);
 assert(s.applyPrepare(*p, S::PrepareReceipt{"prep-1","session","project","capture-1",S::PrepareStatus::prepared,"binding-1",{}}));
 assert(s.applyReadiness(s.beginReadiness(), {"prep-1",true,{}, {"guitar","piano"}}));
}
static void prompts() {
 S s; ready(s); assert(s.canGenerate("guitar",u"")); assert(s.canGenerate("guitar",std::u16string(4096,u'a')));
 assert(!s.canGenerate("guitar",std::u16string(4097,u'a'))); std::u16string emoji;for(int i=0;i<2048;++i)emoji+=u"\U0001f3b5";
 assert(s.canGenerate("guitar",emoji));assert(!s.canGenerate("guitar",emoji+u"a"));emoji+=u"\U0001f3b5";assert(!s.canGenerate("guitar",emoji));
 assert(!s.canGenerate("drums",u"x"));assert(!s.canGenerate("",u"x"));
}
static void replacement() {
 S s;ready(s);auto p=s.beginPrepare("prep-2","capture-2",12);assert(p);assert(s.snapshot().reference->captureId=="capture-1");
 assert(s.applyPrepare(*p,{"prep-2","session","project","capture-2",S::PrepareStatus::failed,{},"failed"}));
 assert(s.snapshot().reference->preparedRequestId=="prep-1" && s.snapshot().reference->durationSeconds==8);
 assert(!s.canGenerate("guitar",u""));
 auto older=s.beginReadiness();auto newer=s.beginReadiness();
 assert(s.applyReadiness(newer,{"other",true,{}, {"guitar"}}));assert(!s.canGenerate("guitar",u""));
 assert(!s.applyReadiness(older,{"prep-1",true,{}, {"guitar"}}));assert(!s.canGenerate("guitar",u""));
}
static void intent() {
 S s;ready(s);auto a=s.beginGeneration("request-1","guitar",u"hello");assert(a && a->send);
 auto duplicate=s.beginGeneration("request-2","piano",u"changed");assert(duplicate && !duplicate->send && duplicate->request.requestId=="request-1");
 assert(duplicate->request.instrument=="guitar" && duplicate->request.prompt==u"hello");
 auto r=S::GenerationReceipt{"request-1","session","project","capture-1","prep-1","binding-1","guitar",u"hello",S::IntentStatus::submitted,"job-1",{}};
 assert(s.applyGeneration(a->request,r)); assert(s.snapshot().generation==S::GenerationStatus::submitted);
 assert(s.applyJob(a->request,"job-1",S::JobStatus::running,S::Occupancy::occupied,{}));
 s.cancelRequested(); assert(s.snapshot().generation==S::GenerationStatus::cancelPending);assert(!s.beginGeneration("request-2","guitar",u"x")->send);
 assert(s.applyJob(a->request,"job-1",S::JobStatus::interrupted,S::Occupancy::unknown,{}));assert(s.snapshot().generation==S::GenerationStatus::unknown);
 assert(!s.beginGeneration("request-2","guitar",u"x")->send);
 assert(s.applyJob(a->request,"job-1",S::JobStatus::ready,S::Occupancy::released,"result-1"));assert(s.snapshot().generation==S::GenerationStatus::ready);assert(s.snapshot().resultId=="result-1");
 auto b=s.beginGeneration("request-2","guitar",u"variation");assert(b && b->send && b->request.requestId=="request-2");
}
static void epochs() {
 S s;ready(s);auto a=s.beginGeneration("r","piano",u"p");assert(a);auto oldReadiness=s.beginReadiness();auto oldEpoch=s.epoch();s.pair("session");assert(s.epoch()!=oldEpoch);
 assert(!s.applyReadiness(oldReadiness,{"prep-1",true,{}, {"piano"}}));assert(!s.applyGeneration(a->request,{"r","session","project","capture-1","prep-1","binding-1","piano",u"p",S::IntentStatus::submitted,"job",{}}));
 assert(s.snapshot().generation==S::GenerationStatus::unknown);assert(!s.canGenerate("piano",u"p"));
 assert(!s.reconcileReleased(oldEpoch));assert(s.reconcileReleased(s.epoch()));assert(s.snapshot().generation==S::GenerationStatus::idle);s.restore();assert(!s.snapshot().paired && !s.snapshot().reference && !s.canGenerate("piano",u""));
}
static void invalid_receipt() {
 S s;ready(s);auto a=s.beginGeneration("r","guitar",u"x");assert(a);
 assert(!s.applyGeneration(a->request,{"r","session","project","capture-1","prep-1","binding-1","piano",u"x",S::IntentStatus::submitted,"job",{}}));
 assert(!s.applyJob(a->request,"job",S::JobStatus::ready,S::Occupancy::released,"result"));
 auto altered=a->request;altered.prompt=u"other";
 assert(!s.applyGeneration(altered,{"r","session","project","capture-1","prep-1","binding-1","guitar",u"other",S::IntentStatus::submitted,"job",{}}));
 s.outcomeUnknown(a->request);assert(s.snapshot().generation==S::GenerationStatus::unknown);
}
static void receipts() {
 S s;ready(s);auto a=s.beginGeneration("req","guitar",u"");assert(a);
 auto pending=S::GenerationReceipt{"req","session","project","capture-1","prep-1","binding-1","guitar",u"Add an instrumental layer",S::IntentStatus::pending,{}, {}};
 assert(s.applyGeneration(a->request,pending));assert(s.snapshot().generation==S::GenerationStatus::checking);
 pending.state=S::IntentStatus::canceled;assert(s.applyGeneration(a->request,pending));assert(s.snapshot().generation==S::GenerationStatus::canceled);
 assert(!s.beginGeneration("req","guitar",u""));assert(s.beginGeneration("next","guitar",u""));
}
static void server_identity() {
 S s;s.pair("session");auto p=s.beginPrepare("client-prep","capture-1",8);assert(p);
 S::PrepareReceipt receipt{"server-prep","session","project","capture-1",S::PrepareStatus::pending,{},{}};
 assert(s.applyPrepare(*p,receipt));auto foreign=receipt;foreign.requestId="foreign";assert(!s.applyPrepare(*p,foreign));
 receipt.state=S::PrepareStatus::prepared;receipt.bindingId="binding-1";assert(s.applyPrepare(*p,receipt));
 assert(s.snapshot().reference->preparedRequestId=="server-prep");
 assert(s.applyReadiness(s.beginReadiness(),{"server-prep",true,{}, {"guitar"}}));
 auto a=s.beginGeneration("client-gen","guitar",u"hello");assert(a);
 S::GenerationReceipt g{"server-gen","session","project","capture-1","server-prep","binding-1","guitar",u"hello",S::IntentStatus::pending,{},{}};
 assert(s.applyGeneration(a->request,g));auto wrong=g;wrong.requestId="foreign";assert(!s.applyGeneration(a->request,wrong));
 g.state=S::IntentStatus::submitted;g.jobId="job";assert(s.applyGeneration(a->request,g));
 assert(s.applyJob(a->request,"job",S::JobStatus::running,S::Occupancy::occupied,{}));
}
static void normalized_prompt() {
 for(auto raw:{std::u16string(),std::u16string(u" \t\u3000\u00a0")}) {
  S s;ready(s);auto a=s.beginGeneration("r","guitar",raw);assert(a);
  auto retry=s.beginGeneration("ignored","piano",u"other");assert(retry && retry->request.prompt==raw);
  S::GenerationReceipt g{"r","session","project","capture-1","prep-1","binding-1","guitar",u"Add an instrumental layer",S::IntentStatus::pending,{},{}};
  assert(s.applyGeneration(a->request,g));
 }
 S s;ready(s);auto a=s.beginGeneration("r","guitar",u" hello ");assert(a);
 S::GenerationReceipt g{"r","session","project","capture-1","prep-1","binding-1","guitar",u"hello",S::IntentStatus::pending,{},{}};
 assert(!s.applyGeneration(a->request,g));g.prompt=u" hello ";assert(s.applyGeneration(a->request,g));
}
static void prepare_rejection() {
 S s;ready(s);auto request=s.beginPrepare("fresh-prepare","capture-2",12);assert(request);
 auto wrong=*request;wrong.captureId="other";assert(!s.rejectPrepare(wrong,"denied"));assert(s.snapshot().preparation==S::PreparationStatus::pending);
 wrong=*request;++wrong.epoch;assert(!s.rejectPrepare(wrong,"denied"));assert(s.snapshot().preparation==S::PreparationStatus::pending);
 assert(s.rejectPrepare(*request,"EXECUTOR_UNAVAILABLE"));assert(s.snapshot().preparation==S::PreparationStatus::failed);assert(s.snapshot().preparationError=="EXECUTOR_UNAVAILABLE");assert(s.snapshot().reference->captureId=="capture-1");
 auto retry=s.beginPrepare("fresh-retry","capture-2",12);assert(retry && retry->requestId!="fresh-prepare");s.pair("session");assert(!s.rejectPrepare(*retry,"stale"));
}
static void accepted_replacement_never_falls_back() {
 for(auto terminal:{S::PrepareStatus::failed,S::PrepareStatus::canceled}) {
  S s;ready(s);auto oldBeforeBegin=s.beginReadiness();auto b=s.beginPrepare("client-b","capture-2",12);assert(b);
  assert(!s.canGenerate("guitar",u""));assert(!s.applyReadiness(oldBeforeBegin,{"prep-1",true,{}, {"guitar"}}));
  auto receipt=S::PrepareReceipt{"server-b","session","project","capture-2",S::PrepareStatus::pending,{}, {}};assert(s.applyPrepare(*b,receipt));auto pendingReadiness=s.beginReadiness();
  receipt.state=terminal;receipt.error="replacement closed";assert(s.applyPrepare(*b,receipt));assert(s.snapshot().reference->preparedRequestId=="prep-1");
  assert(!s.canGenerate("guitar",u""));assert(!s.applyReadiness(pendingReadiness,{"prep-1",true,{}, {"guitar"}}));
  assert(s.applyReadiness(s.beginReadiness(),{"prep-1",true,{}, {"guitar"}}));assert(!s.canGenerate("guitar",u""));
  auto rejected=s.beginPrepare("client-c","capture-3",4);assert(rejected && s.rejectPrepare(*rejected,"not accepted"));assert(s.applyReadiness(s.beginReadiness(),{"prep-1",true,{}, {"guitar"}}));assert(!s.canGenerate("guitar",u""));
  auto c=s.beginPrepare("client-d","capture-3",4);assert(c);auto staleDuringSuccess=s.beginReadiness();assert(s.applyPrepare(*c,{"server-d","session","project","capture-3",S::PrepareStatus::prepared,"binding-d",{}}));assert(!s.applyReadiness(staleDuringSuccess,{"prep-1",true,{}, {"guitar"}}));assert(s.applyReadiness(s.beginReadiness(),{"server-d",true,{}, {"guitar"}}));assert(s.canGenerate("guitar",u""));
 }
 S s;ready(s);auto rejected=s.beginPrepare("never-accepted","capture-2",12);assert(rejected);assert(!s.canGenerate("guitar",u""));auto staleDuringReject=s.beginReadiness();assert(s.rejectPrepare(*rejected,"409"));assert(!s.applyReadiness(staleDuringReject,{"prep-1",true,{}, {"guitar"}}));assert(!s.canGenerate("guitar",u""));assert(s.applyReadiness(s.beginReadiness(),{"prep-1",true,{}, {"guitar"}}));assert(s.canGenerate("guitar",u""));
}
static void generation_rejection() {
 S s;ready(s);auto request=s.beginGeneration("reject-request","guitar",u" raw ");assert(request);
 auto wrong=request->request;wrong.prompt=u"raw";assert(!s.rejectGeneration(wrong,"denied"));assert(s.snapshot().generation==S::GenerationStatus::checking);
 wrong=request->request;++wrong.epoch;assert(!s.rejectGeneration(wrong,"denied"));assert(s.rejectGeneration(request->request,"BACKEND_BUSY"));assert(s.snapshot().generation==S::GenerationStatus::failed && s.snapshot().error=="BACKEND_BUSY");assert(s.snapshot().reference->captureId=="capture-1");assert(!s.beginGeneration("reject-request","guitar",u" raw "));auto retry=s.beginGeneration("new-request","guitar",u" raw ");assert(retry && retry->send);s.restore();assert(!s.rejectGeneration(retry->request,"stale"));
}
static void job_failure_diagnostics() {
 S s;ready(s);auto a=s.beginGeneration("fail-request","guitar",u"x");assert(a);
 assert(s.applyGeneration(a->request,{"server-intent","session","project","capture-1","prep-1","binding-1","guitar",u"x",S::IntentStatus::submitted,"job-1",{}}));
 assert(!s.applyJob(a->request,"foreign",S::JobStatus::failed,S::Occupancy::released,{},"wrong job"));assert(s.snapshot().error.empty());
 auto stale=a->request;++stale.epoch;assert(!s.applyJob(stale,"job-1",S::JobStatus::failed,S::Occupancy::released,{},"stale"));assert(s.snapshot().error.empty());
 assert(s.applyJob(a->request,"job-1",S::JobStatus::failed,S::Occupancy::unknown,{},"unconfirmed"));assert(s.snapshot().generation==S::GenerationStatus::unknown && s.snapshot().error.empty());
 assert(s.applyJob(a->request,"job-1",S::JobStatus::failed,S::Occupancy::released,{},"Model unavailable; check model configuration"));assert(s.snapshot().error=="Model unavailable; check model configuration");
 auto b=s.beginGeneration("next-request","guitar",u"x");assert(b && s.snapshot().error.empty());assert(s.applyGeneration(b->request,{"intent-2","session","project","capture-1","prep-1","binding-1","guitar",u"x",S::IntentStatus::submitted,"job-2",{}}));
 assert(s.applyJob(b->request,"job-2",S::JobStatus::interrupted,S::Occupancy::released,{}));assert(s.snapshot().error=="Details unavailable; inspect ACE-Step DAW for more information");
}
static void preparation_status_and_uncertainty() {
 S s;ready(s);auto b=s.beginPrepare("client-b","capture-b",1);assert(b);auto stale=*b;++stale.epoch;
 assert(!s.prepareOutcomeUnknown(stale));auto foreign=*b;foreign.captureId="foreign";assert(!s.prepareOutcomeUnknown(foreign));assert(s.snapshot().preparationDiagnostic.empty());assert(s.prepareOutcomeUnknown(*b));assert(s.snapshot().preparation==S::PreparationStatus::pending && !s.snapshot().preparationDiagnostic.empty());assert(!s.canGenerate("guitar",u"x"));
 assert(s.applyPrepare(*b,{"server-b","session","project","capture-b",S::PrepareStatus::pending,{},{}}));assert(s.snapshot().preparationDiagnostic.empty());assert(s.prepareOutcomeUnknown(*b));assert(s.applyPrepare(*b,{"server-b","session","project","capture-b",S::PrepareStatus::prepared,"binding-b",{}}));assert(s.snapshot().preparationDiagnostic.empty());
 for(auto closed:{S::PrepareStatus::failed,S::PrepareStatus::canceled}) {S x;ready(x);auto request=x.beginPrepare("client-x","capture-x",1);assert(request && x.prepareOutcomeUnknown(*request));assert(x.applyPrepare(*request,{"server-x","session","project","capture-x",closed,{},"closed"}));assert(x.snapshot().preparationDiagnostic.empty() && x.snapshot().preparationError=="closed");assert(!x.prepareOutcomeUnknown(*request));}
 S t;ready(t);auto rejected=t.beginPrepare("reject","capture-b",1);assert(rejected && t.rejectPrepare(*rejected,"old error"));assert(t.applyReadiness(t.beginReadiness(),{"prep-1",true,{}, {"guitar"}}));auto first=t.beginGeneration("new","guitar",u"x");assert(first && first->send);assert(t.snapshot().preparation==S::PreparationStatus::prepared && t.snapshot().preparationError.empty());auto before=t.snapshot();auto again=t.beginGeneration("duplicate","guitar",u"x");assert(again && !again->send);assert(t.snapshot().preparation==before.preparation && t.snapshot().preparationError==before.preparationError && t.snapshot().reference->preparedRequestId==before.reference->preparedRequestId);
}
int main(int argc,char** argv){if(argc>1 && std::string(argv[1])=="identity"){server_identity();return 0;}if(argc>1 && std::string(argv[1])=="prompt"){normalized_prompt();return 0;}preparation_status_and_uncertainty();job_failure_diagnostics();accepted_replacement_never_falls_back();generation_rejection();prepare_rejection();prompts();replacement();intent();epochs();invalid_receipt();receipts();server_identity();normalized_prompt();std::cout<<"PASS generation state\n";}
