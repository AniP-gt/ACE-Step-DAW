#pragma once
#include <cstdint>
#include <optional>
#include <string>

// Tracks the AU's outstanding direct Cover request independently of its editor.
class DirectGenerationState {
public:
 enum class Status { idle, submitting, queued, running, unknown, ready, failed };
 struct Request {
  std::uint64_t epoch;
  std::string sessionId, captureId, clientRequestId;
  std::u16string prompt;
 };
 void pair(std::string session) {
  ++epoch_; session_=std::move(session); source_.clear(); duration_=0;
  active_.reset(); serverId_.clear(); result_.clear(); error_.clear(); status_=Status::idle;
 }
 void reset() {pair({});}
 void captureReady(const std::string& session, std::string source, double duration) {
  if(session==session_ && !session.empty() && !source.empty() && duration>0) {source_=std::move(source);duration_=duration;}
 }
 std::optional<Request> begin(std::string clientId, std::u16string prompt) {
  if(session_.empty() || source_.empty() || clientId.empty() || busy() || !validPrompt(prompt))return {};
  Request request{epoch_,session_,source_,std::move(clientId),std::move(prompt)};
  active_=request;serverId_.clear();result_.clear();error_.clear();status_=Status::submitting;
  return request;
 }
 static bool validPrompt(const std::u16string& prompt) {
  if(prompt.empty() || prompt.size()>4096)return false;
  for(auto c:prompt) {
   const bool space=(c>=0x09 && c<=0x0d) || c==0x20 || c==0x00a0 || c==0x1680 || (c>=0x2000 && c<=0x200a) || c==0x2028 || c==0x2029 || c==0x202f || c==0x205f || c==0x3000 || c==0xfeff;
   if(!space)return true;
  }
  return false;
 }
 bool apply(const Request& request,const std::string& serverId,const std::string& session,const std::string& capture,const std::string& state,const std::string& result,const std::string& error) {
  if(!matches(request) || serverId.empty() || session!=request.sessionId || capture!=request.captureId || (!serverId_.empty() && serverId_!=serverId))return false;
  Status next;
  if(state=="queued") next=Status::queued;
  else if(state=="running") next=Status::running;
  else if(state=="ready" && !result.empty()) next=Status::ready;
  else if(state=="failed") next=Status::failed;
  else if(state=="interrupted") next=Status::unknown;
  else return false;
  serverId_=serverId;status_=next;result_=result;error_=error;return true;
 }
 void outcomeUnknown(const Request& request) {if(matches(request))status_=Status::unknown;}
 void rejected(const Request& request,std::string error) {if(matches(request)){status_=Status::failed;error_=std::move(error);}}
 bool paired() const {return !session_.empty();}
 bool busy() const {return status_==Status::submitting || status_==Status::queued || status_==Status::running || status_==Status::unknown;}
 bool matches(const Request& request) const {return active_ && request.epoch==epoch_ && request.epoch==active_->epoch && request.sessionId==active_->sessionId && request.captureId==active_->captureId && request.clientRequestId==active_->clientRequestId && request.prompt==active_->prompt;}
 const std::optional<Request>& active() const {return active_;}
 const std::string& sourceId() const {return source_;}
 double duration() const {return duration_;}
 const std::string& serverId() const {return serverId_;}
 const std::string& resultId() const {return result_;}
 const std::string& error() const {return error_;}
 Status status() const {return status_;}
private:
 std::uint64_t epoch_=0;
 std::string session_,source_,serverId_,result_,error_;
 double duration_=0;
 std::optional<Request> active_;
 Status status_=Status::idle;
};
