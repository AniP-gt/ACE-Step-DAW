#pragma once
#include "ResultCatalogState.h"
#include <condition_variable>
#include <mutex>
#include <thread>
#include <cmath>
#if JUCE_MAC
#include <pthread/qos.h>
#endif

// The watchdog owns a shared stream until cancellation completes; no processor lock is held.
class ResultCatalogClient {
public:
 struct StopControl {
  std::mutex mutex;std::condition_variable cv;bool stopping=false;
  void stop() {{std::lock_guard<std::mutex> lock(mutex);stopping=true;}cv.notify_all();}
 };
 static std::optional<ResultCatalogState::Page> fetch(const ResultCatalogState::Request& request,StopControl& stop) {
  auto url=juce::URL("http://127.0.0.1:5176/v1/results").withParameter("sessionId",request.sessionId).withParameter("limit","50");
  if(!request.beforeResultId.empty()) url=url.withParameter("beforeResultId",request.beforeResultId);
  auto stream=std::make_shared<juce::WebInputStream>(url,false);
  stream->withExtraHeaders("X-Bridge-Protocol: 1\r\nAuthorization: Bearer "+juce::String(request.credential)+"\r\n").withConnectionTimeout(3000).withNumRedirectsToFollow(0);
  bool finished=false;std::atomic<bool> canceled{false};
  std::thread watchdog([&]{
#if JUCE_MAC
   // Keep the deadline watchdog at the original default QoS despite its background parent.
   if(const auto result=pthread_set_qos_class_self_np(QOS_CLASS_DEFAULT,0);result!=0)juce::Logger::writeToLog("Catalog watchdog QoS setup failed: "+juce::String(result));
#endif
   std::unique_lock<std::mutex> lock(stop.mutex);stop.cv.wait_for(lock,std::chrono::seconds(5),[&]{return finished || stop.stopping;});
   if(!finished) {
    canceled=true;
    while(!finished) {lock.unlock();stream->cancel();lock.lock();stop.cv.wait_for(lock,std::chrono::milliseconds(15),[&]{return finished;});}
   }});
  juce::MemoryBlock bytes;bool ok=stream->connect(nullptr) && stream->getStatusCode()==200;
  if(ok) {
   char buffer[8192];
   while(!canceled && !stream->isExhausted()) {int n=stream->read(buffer,sizeof(buffer));if(n<=0){ok=stream->isExhausted() && !stream->isError();break;}if(bytes.getSize()+static_cast<size_t>(n)>256*1024){ok=false;break;}bytes.append(buffer,static_cast<size_t>(n));}
  }
  {std::lock_guard<std::mutex> lock(stop.mutex);finished=true;}stop.cv.notify_all();watchdog.join();
  if(!ok || canceled)return std::nullopt;
  juce::var data;auto text=juce::String::fromUTF8(static_cast<const char*>(bytes.getData()),static_cast<int>(bytes.getSize()));
  if(juce::JSON::parse(text,data).failed() || !data.isObject() || data["sessionId"].toString()!=juce::String(request.sessionId) || !data["results"].isArray())return std::nullopt;
  auto cursor=data["nextBeforeResultId"];if(!cursor.isVoid() && !cursor.isString())return std::nullopt;
  auto* rows=data["results"].getArray();if(rows->size()>100)return std::nullopt;
  ResultCatalogState::Page page;page.nextBeforeResultId=cursor.toString().toStdString();
  for(const auto& row:*rows){
   auto frame=row["frameCount"],order=row["publicationOrder"],placement=row["placementSeconds"];
   if(!row.isObject() || !row["resultId"].isString() || row["resultId"].toString().isEmpty() || !row["jobId"].isString() || !row["instrument"].isString() || !(frame.isInt()||frame.isInt64()) || static_cast<juce::int64>(frame)<0 || !(order.isInt()||order.isInt64()) || static_cast<juce::int64>(order)<=0 || !(placement.isDouble()||placement.isInt()||placement.isInt64()) || !std::isfinite(static_cast<double>(placement)))return std::nullopt;
   page.results.push_back({row["resultId"].toString().toStdString(),row["jobId"].toString().toStdString(),row["instrument"].toString().toStdString(),static_cast<std::uint64_t>(static_cast<juce::int64>(frame)),static_cast<double>(placement),static_cast<std::uint64_t>(static_cast<juce::int64>(order))});
  }
  return page;
 }
};
