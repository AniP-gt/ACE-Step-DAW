#pragma once
#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// Pure model: caller serializes all access, snapshots each Request under the same lock
// as pairing/host state, performs I/O outside that lock, and returns the Request intact.
// No selection, audio cache, clock, networking or scheduling is owned by this model.
class ResultCatalogState {
public:
 struct Summary { std::string resultId, jobId, instrument; std::uint64_t frameCount; double placementSeconds; std::uint64_t publicationOrder; };
 struct Page { std::vector<Summary> results; std::string nextBeforeResultId; };
 struct Request { std::uint64_t id, generation, navigation; std::string sessionId, credential, beforeResultId; };

 // Pairing again always invalidates outstanding credentials; same-session repair retains baseline.
 void pair(std::string session, std::string credential) {
  if (session.empty() || credential.empty()) { unpair(); return; }
  if (session != sessionId_) resetCatalog();
  sessionId_=std::move(session); credential_=std::move(credential); ++generation_;
  pending_=false; stale_=false; failures_=0; ++navigation_;
 }
 void unpair() { credential_.clear(); ++generation_; pending_=false; }
 // Host restore invalidates both the credentials and the session's runtime baseline.
 void restore() { ++generation_; credential_.clear(); sessionId_.clear(); pending_=false; resetCatalog(); }
 void setVisible(bool visible) { if (visible_ && !visible) { ++generation_; pending_=false; } visible_=visible; }
 // A refresh is always the latest page, even when the user is browsing older rows.
 void refresh() { if (visible_ && paired() && (!pending_ || pendingBefore_.empty())) { pending_=true; pendingBefore_.clear(); pendingNavigation_=navigation_; } }
 void older(std::string cursor) { if (cursor.empty()) return; ++navigation_; browsingOlder_=true; enqueue(std::move(cursor)); }
 void latest() { ++navigation_; browsingOlder_=false; enqueue({}); }
 std::optional<Request> begin() {
  if (!visible_ || !paired() || !pending_ || active_) return std::nullopt;
  pending_=false; active_=Request{++requestId_,generation_,pendingNavigation_,sessionId_,credential_,pendingBefore_}; return active_;
 }
 void succeed(const Request& request, Page page) {
  if (!isActive(request)) return;
  active_.reset();
  if (request.generation!=generation_) return;
  failures_=0; stale_=false;
  if (request.beforeResultId.empty()) {
   std::uint64_t maxOrder=0; for (const auto& result:page.results) maxOrder=std::max(maxOrder,result.publicationOrder);
   if (baseline_ && maxOrder>highWater_) notice_=true;
   highWater_=std::max(highWater_,maxOrder); baseline_=true;
  }
  if (request.navigation==navigation_ && (!request.beforeResultId.empty() || !browsingOlder_)) rows_=std::move(page);
 }
 void fail(const Request& request) {
  if (!isActive(request)) return;
  active_.reset(); if (request.generation!=generation_) return;
  stale_=true; failures_=std::min(failures_+1,4);
 }
 void dismissNotice() { notice_=false; }
 bool paired() const { return !sessionId_.empty() && !credential_.empty(); }
 bool visible() const { return visible_; }
 bool inFlight() const { return active_.has_value(); }
 bool baseline() const { return baseline_; }
 bool notice() const { return notice_; }
 bool stale() const { return stale_; }
 std::uint64_t generation() const { return generation_; }
 std::uint64_t highWater() const { return highWater_; }
 // Delay after completion; the caller's worker owns its clock and invokes refresh when due.
 int retrySeconds() const { return failures_<=1 ? 5 : failures_==2 ? 10 : failures_==3 ? 20 : 30; }
 const Page& rows() const { return rows_; }
 std::optional<Request> activeRequest() const { return active_; }
private:
 void enqueue(std::string cursor) { if (visible_ && paired()) { pending_=true; pendingBefore_=std::move(cursor); pendingNavigation_=navigation_; } }
 bool isActive(const Request& request) const { return active_ && active_->id==request.id; }
 void resetCatalog() { baseline_=false; highWater_=0; notice_=false; stale_=false; failures_=0; rows_={}; browsingOlder_=false; ++navigation_; }
 bool visible_=false, pending_=false, browsingOlder_=false, baseline_=false, notice_=false, stale_=false;
 int failures_=0;
 std::uint64_t generation_=0, navigation_=0, requestId_=0, pendingNavigation_=0, highWater_=0;
 std::string sessionId_, credential_, pendingBefore_;
 Page rows_;
 std::optional<Request> active_;
};
