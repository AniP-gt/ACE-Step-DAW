#pragma once
#include <algorithm>
#include <cstdint>
#include <cmath>
#include <cctype>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

// Pure state only. The owner serializes access and performs network I/O outside its lock.
// Request snapshots carry an epoch: results from a prior pair or restore are ignored.
// Prompt is UTF-16 to match JavaScript string.length; the client converts at the wire boundary.
class GenerationState {
public:
 enum class PrepareStatus { pending, prepared, failed, canceled };
 enum class PreparationStatus { idle, pending, prepared, failed, canceled };
 enum class IntentStatus { pending, submitted, failed, canceled };
 enum class JobStatus { queued, dispatched, running, exporting, ready, failed, interrupted, canceled };
 enum class Occupancy { reserved, occupied, unknown, released };
 enum class CaptureStatus { idle, capturing, uploading, ready, failed, canceled };
 enum class OutputStatus { empty, available, fetching, ready, failed };
 enum class GenerationStatus { idle, checking, submitted, queued, dispatched, running, exporting, cancelPending, ready, failed, interrupted, canceled, unknown };
 struct Reference {std::string preparedRequestId,sessionId,projectId,captureId,bindingId;double durationSeconds;};
 struct Readiness {std::string preparedRequestId;bool ready=false;std::string reason;std::vector<std::string> instruments;};
 struct ReadinessRequest {std::uint64_t epoch,sequence;};
 struct PrepareRequest {std::uint64_t epoch;std::string requestId,sessionId,captureId;double durationSeconds;};
 struct PrepareReceipt {std::string requestId,sessionId,projectId,captureId;PrepareStatus state;std::string bindingId,error;};
 struct GenerationRequest {std::uint64_t epoch;std::string requestId,sessionId,projectId,captureId,preparedRequestId,bindingId,instrument;std::u16string prompt;};
 struct GenerationReceipt {std::string requestId,sessionId,projectId,captureId,preparedRequestId,bindingId,instrument;std::u16string prompt;IntentStatus state;std::string jobId,error;};
 struct BeginGeneration {GenerationRequest request;bool send;};
 struct Snapshot {bool paired;Readiness readiness;std::optional<Reference> reference;CaptureStatus capture;OutputStatus output;PreparationStatus preparation;GenerationStatus generation;std::string preparationError,requestId,jobId,resultId,error,preparationDiagnostic;};

 void pair(std::string session) {
  invalidate();sessionId_=std::move(session);paired_=!sessionId_.empty();readiness_={};
  // A receipt belongs to the credential that created it, even for the same session.
  reference_.reset();
 }
 void restore() {invalidate();paired_=false;sessionId_.clear();readiness_={};reference_.reset();capture_=CaptureStatus::idle;}
 std::uint64_t epoch() const {return epoch_;}
 void setCapture(CaptureStatus status) {capture_=status;}
 void setOutput(OutputStatus status) {output_=status;}
 Snapshot snapshot() const {return {paired_,readiness_,reference_,capture_,output_,preparation_,generation_,preparationError_,requestId_,jobId_,resultId_,error_,preparationDiagnostic_};}

 std::optional<PrepareRequest> beginPrepare(std::string requestId,std::string captureId,double durationSeconds) {
  if(!paired_ || requestId.empty() || captureId.empty() || (!std::isfinite(durationSeconds) || durationSeconds<=0) || preparing_)return std::nullopt;
  readiness_={};++readinessSequence_;preparing_=PrepareRequest{epoch_,std::move(requestId),sessionId_,std::move(captureId),durationSeconds};preparation_=PreparationStatus::pending;preparationError_.clear();preparationDiagnostic_.clear();prepareProject_.clear();prepareReceiptId_.clear();return preparing_;
 }
 bool prepareOutcomeUnknown(const PrepareRequest& request) {
  if(!preparing_ || request.epoch!=epoch_ || request.requestId!=preparing_->requestId || request.sessionId!=preparing_->sessionId || request.captureId!=preparing_->captureId || request.durationSeconds!=preparing_->durationSeconds)return false;
  preparationDiagnostic_="Reference preparation status unknown; checking status. Check ACE-Step DAW before retrying.";return true;
 }
 bool rejectPrepare(const PrepareRequest& request,std::string error) {
  if(!preparing_ || request.epoch!=epoch_ || request.requestId!=preparing_->requestId || request.sessionId!=preparing_->sessionId || request.captureId!=preparing_->captureId || request.durationSeconds!=preparing_->durationSeconds)return false;
  readiness_={};++readinessSequence_;preparationDiagnostic_.clear();preparation_=PreparationStatus::failed;preparationError_=std::move(error);preparing_.reset();return true;
 }
 bool applyPrepare(const PrepareRequest& request,const PrepareReceipt& receipt) {
  if(!preparing_ || request.epoch!=epoch_ || preparing_->requestId!=request.requestId ||
     (receipt.requestId.empty() || (!prepareReceiptId_.empty() && receipt.requestId!=prepareReceiptId_)) || receipt.sessionId!=request.sessionId || receipt.captureId!=request.captureId || receipt.projectId.empty() || request.sessionId!=preparing_->sessionId || request.captureId!=preparing_->captureId || request.durationSeconds!=preparing_->durationSeconds || (!prepareProject_.empty() && prepareProject_!=receipt.projectId))return false;
  if(receipt.state==PrepareStatus::prepared && receipt.bindingId.empty())return false;
  preparationDiagnostic_.clear();prepareProject_=receipt.projectId;prepareReceiptId_=receipt.requestId;latestAcceptedPrepareId_=receipt.requestId;
  if(receipt.state==PrepareStatus::pending)return true;
  readiness_={};++readinessSequence_;
  if(receipt.state==PrepareStatus::prepared) {
   if(receipt.bindingId.empty())return false;
   reference_=Reference{receipt.requestId,receipt.sessionId,receipt.projectId,receipt.captureId,receipt.bindingId,request.durationSeconds};
   readiness_={};preparation_=PreparationStatus::prepared;
  } else {preparation_=receipt.state==PrepareStatus::failed?PreparationStatus::failed:PreparationStatus::canceled;preparationError_=receipt.error;}
  preparing_.reset();return true;
 }
 ReadinessRequest beginReadiness() {return {epoch_,++readinessSequence_};}
 bool applyReadiness(ReadinessRequest request,Readiness value) {
  if(request.epoch!=epoch_ || request.sequence!=readinessSequence_ || !paired_)return false;
  if(value.ready && !latestAcceptedPrepareId_.empty() && value.preparedRequestId!=latestAcceptedPrepareId_){value.ready=false;value.reason="REFERENCE_UNAVAILABLE";}
  readiness_=std::move(value);return true;
 }
 bool canGenerate(const std::string& instrument,const std::u16string& prompt) const {
  return paired_ && reference_ && !preparing_ && latestAcceptedPrepareId_==reference_->preparedRequestId && readiness_.ready && readiness_.preparedRequestId==reference_->preparedRequestId &&
   !instrument.empty() && std::find(readiness_.instruments.begin(),readiness_.instruments.end(),instrument)!=readiness_.instruments.end() &&
   prompt.size()<=4096 && !active_ && generation_!=GenerationStatus::unknown;
 }
 std::optional<BeginGeneration> beginGeneration(std::string requestId,std::string instrument,std::u16string prompt) {
  if(active_)return BeginGeneration{*active_,false};
  if(requestId.empty() || usedIds_.count(requestId) || !canGenerate(instrument,prompt))return std::nullopt;
  preparation_=PreparationStatus::prepared;preparationError_.clear();preparationDiagnostic_.clear();
  const auto& ref=*reference_;
  active_=GenerationRequest{epoch_,std::move(requestId),ref.sessionId,ref.projectId,ref.captureId,ref.preparedRequestId,ref.bindingId,std::move(instrument),std::move(prompt)};
  usedIds_.insert(active_->requestId);requestId_=active_->requestId;generationReceiptId_.clear();jobId_.clear();resultId_.clear();error_.clear();generation_=GenerationStatus::checking;
  return BeginGeneration{*active_,true};
 }
 bool rejectGeneration(const GenerationRequest& request,std::string error) {
  if(!matches(request))return false;generation_=GenerationStatus::failed;error_=std::move(error);active_.reset();return true;
 }
 bool applyGeneration(const GenerationRequest& request,const GenerationReceipt& receipt) {
  if(!matches(request) || (receipt.requestId.empty() || (!generationReceiptId_.empty() && receipt.requestId!=generationReceiptId_)) || receipt.sessionId!=request.sessionId || receipt.projectId!=request.projectId ||
     receipt.captureId!=request.captureId || receipt.preparedRequestId!=request.preparedRequestId || receipt.bindingId!=request.bindingId ||
     receipt.instrument!=request.instrument || receipt.prompt!=canonicalPrompt(request.prompt))return false;
  if(receipt.state==IntentStatus::submitted && receipt.jobId.empty())return false;
  generationReceiptId_=receipt.requestId;
  if(!jobId_.empty())return receipt.state==IntentStatus::submitted && receipt.jobId==jobId_;
  switch(receipt.state) {
   case IntentStatus::pending:return true;
   case IntentStatus::submitted:if(receipt.jobId.empty())return false;jobId_=receipt.jobId;generation_=GenerationStatus::submitted;return true;
   case IntentStatus::failed:generation_=GenerationStatus::failed;break;
   case IntentStatus::canceled:generation_=GenerationStatus::canceled;break;
  }
  error_=receipt.error;active_.reset();return true;
 }
 bool applyJob(const GenerationRequest& request,const std::string& jobId,JobStatus state,Occupancy occupancy,std::string resultId,std::string error={}) {
  if(!matches(request) || jobId_.empty() || jobId!=jobId_)return false;
  if(occupancy==Occupancy::unknown) {generation_=GenerationStatus::unknown;return true;}
  if(state==JobStatus::failed || state==JobStatus::interrupted) {
   const bool blank=std::all_of(error.begin(),error.end(),[](unsigned char c){return std::isspace(c)!=0;});
   error_=blank?"Details unavailable; inspect ACE-Step DAW for more information":std::move(error);
  }
  switch(state) {
   case JobStatus::queued:generation_=GenerationStatus::queued;break;
   case JobStatus::dispatched:generation_=GenerationStatus::dispatched;break;
   case JobStatus::running:generation_=GenerationStatus::running;break;
   case JobStatus::exporting:generation_=GenerationStatus::exporting;break;
   case JobStatus::ready:if(resultId.empty())return false;generation_=GenerationStatus::ready;resultId_=std::move(resultId);break;
   case JobStatus::failed:generation_=GenerationStatus::failed;break;
   case JobStatus::interrupted:generation_=GenerationStatus::interrupted;break;
   case JobStatus::canceled:generation_=GenerationStatus::canceled;break;
  }
  if(terminal(generation_)) {
   if(occupancy!=Occupancy::released){generation_=GenerationStatus::unknown;return true;}
   active_.reset();
  }
  return true;
 }
 // Call only after authoritative service reconciliation reports released occupancy.
 bool reconcileReleased(std::uint64_t epoch) {if(epoch!=epoch_ || active_ || generation_!=GenerationStatus::unknown)return false;generation_=GenerationStatus::idle;return true;}
 void outcomeUnknown(const GenerationRequest& request) {if(matches(request))generation_=GenerationStatus::unknown;}
 void cancelRequested() {if(active_ && generation_!=GenerationStatus::unknown)generation_=GenerationStatus::cancelPending;}
private:
 static bool jsWhitespace(char16_t c) {
  return (c>=0x0009 && c<=0x000d) || c==0x0020 || c==0x00a0 || c==0x1680 ||
   (c>=0x2000 && c<=0x200a) || c==0x2028 || c==0x2029 || c==0x202f || c==0x205f || c==0x3000 || c==0xfeff;
 }
 static std::u16string canonicalPrompt(const std::u16string& value) {
  return std::all_of(value.begin(),value.end(),jsWhitespace)?u"Add an instrumental layer":value;
 }
 static bool terminal(GenerationStatus value) {return value==GenerationStatus::ready || value==GenerationStatus::failed || value==GenerationStatus::interrupted || value==GenerationStatus::canceled;}
 bool matches(const GenerationRequest& request) const {return active_ && request.epoch==epoch_ && request.epoch==active_->epoch && request.requestId==active_->requestId && request.sessionId==active_->sessionId && request.projectId==active_->projectId && request.captureId==active_->captureId && request.preparedRequestId==active_->preparedRequestId && request.bindingId==active_->bindingId && request.instrument==active_->instrument && request.prompt==active_->prompt;}
 void invalidate() {++epoch_;++readinessSequence_;latestAcceptedPrepareId_.clear();preparing_.reset();preparation_=PreparationStatus::idle;preparationError_.clear();preparationDiagnostic_.clear();if(active_)generation_=GenerationStatus::unknown;active_.reset();}
 std::uint64_t epoch_=0,readinessSequence_=0;bool paired_=false;std::string sessionId_;
 Readiness readiness_;std::optional<Reference> reference_;std::optional<PrepareRequest> preparing_;std::optional<GenerationRequest> active_;
 PreparationStatus preparation_=PreparationStatus::idle;std::string preparationError_,preparationDiagnostic_,prepareProject_,prepareReceiptId_,latestAcceptedPrepareId_,generationReceiptId_;
 CaptureStatus capture_=CaptureStatus::idle;OutputStatus output_=OutputStatus::empty;GenerationStatus generation_=GenerationStatus::idle;
 std::set<std::string> usedIds_;std::string requestId_,jobId_,resultId_,error_;
};
