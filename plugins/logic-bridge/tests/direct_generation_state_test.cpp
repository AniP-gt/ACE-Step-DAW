#include "DirectGenerationState.h"
#include <cassert>
#include <iostream>
using S = DirectGenerationState;
int main() {
 S s;
 assert(!s.begin("client-1",u"solo violin"));
 s.pair("session-1");
 assert(!s.begin("client-1",u"solo violin"));
 s.captureReady("session-1","capture-1",8.0);
 assert(!s.begin("client-1",u" \t\n\u2003\ufeff"));
 assert(!s.begin("client-1",std::u16string(4097,u'a')));
 auto first=s.begin("client-1",u"solo violin");
 assert(first && first->captureId=="capture-1" && first->sessionId=="session-1");
 assert(!s.begin("client-2",u"other"));
 s.captureReady("session-1","capture-2",4.0);
 assert(s.sourceId()=="capture-2" && first->captureId=="capture-1");
 assert(!s.apply(*first,"job-1","session-2","capture-1","running","", ""));
 assert(!s.apply(*first,"job-1","session-1","capture-2","running","", ""));
 s.outcomeUnknown(*first);
 assert(s.busy() && s.status()==S::Status::unknown);
 assert(!s.begin("client-2",u"other"));
 assert(s.apply(*first,"job-1","session-1","capture-1","running","", ""));
 assert(!s.apply(*first,"job-2","session-1","capture-1","ready","other", ""));
 assert(!s.apply(*first,"job-1","session-1","capture-1","ready","", ""));
 assert(s.apply(*first,"job-1","session-1","capture-1","ready","result-1", ""));
 assert(!s.busy() && s.resultId()=="result-1");
 auto next=s.begin("client-2",u"guitar");assert(next);
 s.pair("session-2");
 assert(!s.apply(*next,"job-2","session-1","capture-2","ready","result-2", ""));
 assert(s.sourceId().empty());
 s.captureReady("session-1","foreign",4.0);assert(s.sourceId().empty());
 S resumed;resumed.pair("session");resumed.captureReady("session","capture",1.0);
 auto interrupted=resumed.begin("old-client",u"violin");assert(interrupted);
 assert(resumed.apply(*interrupted,"old-job","session","capture","queued","", ""));
 assert(resumed.apply(*interrupted,"old-job","session","capture","interrupted","", "SUBMISSION_OUTCOME_UNKNOWN"));
 assert(resumed.busy() && !resumed.begin("new-client",u"violin"));
 assert(resumed.apply(*interrupted,"old-job","session","capture","failed","", "SUBMISSION_OUTCOME_UNKNOWN"));
 assert(!resumed.busy() && resumed.error()=="SUBMISSION_OUTCOME_UNKNOWN");
 auto retried=resumed.begin("new-client",u"violin");assert(retried && retried->clientRequestId!="old-client");
 assert(resumed.apply(*retried,"new-job","session","capture","ready","new-result", ""));
 assert(!resumed.apply(*interrupted,"old-job","session","capture","ready","stale-result", ""));
 std::cout<<"PASS direct generation validation, identity, unknown and stale epochs\n";
}
