#pragma once
#include <condition_variable>
#include <mutex>
#include <thread>

// Each call owns its stream and cancels it on deadline; credentials are immutable snapshots.
class GenerationClient {
public:
 struct Reply { int status=0; juce::var body; bool valid=false, parsed=false; };
 static Reply request(unsigned short port,const juce::String& credential,const juce::String& method,const juce::String& path,const juce::var& body={}) {
  auto url=juce::URL("http://127.0.0.1:"+juce::String(port)+"/v1"+path);
  if(!body.isVoid())url=url.withPOSTData(juce::JSON::toString(body));
  auto stream=std::make_shared<juce::WebInputStream>(url,method=="POST");
  stream->withCustomRequestCommand(method).withExtraHeaders("X-Bridge-Protocol: 1\r\nAuthorization: Bearer "+credential+"\r\nContent-Type: application/json\r\n").withConnectionTimeout(3000).withNumRedirectsToFollow(0);
  std::mutex mutex;std::condition_variable wake;bool finished=false;std::atomic<bool> expired{false};
  std::thread watchdog([&]{std::unique_lock<std::mutex> lock(mutex);if(!wake.wait_for(lock,std::chrono::seconds(5),[&]{return finished;})){expired=true;while(!finished){lock.unlock();stream->cancel();lock.lock();wake.wait_for(lock,std::chrono::milliseconds(15),[&]{return finished;});}}});
  juce::MemoryBlock bytes;bool ok=stream->connect(nullptr);int status=stream->getStatusCode();char buffer[8192];
  if(ok)while(!expired && !stream->isExhausted()){auto n=stream->read(buffer,sizeof(buffer));if(n<=0){ok=stream->isExhausted() && !stream->isError();break;}if(bytes.getSize()+static_cast<size_t>(n)>256*1024){ok=false;break;}bytes.append(buffer,static_cast<size_t>(n));}
  {std::lock_guard<std::mutex> lock(mutex);finished=true;}wake.notify_one();watchdog.join();
  Reply reply;reply.status=status;
  if(!ok || expired)return reply;
  auto text=juce::String::fromUTF8(static_cast<const char*>(bytes.getData()),static_cast<int>(bytes.getSize()));
  reply.parsed=juce::JSON::parse(text,reply.body).wasOk() && reply.body.isObject();
  reply.valid=reply.parsed && status>=200 && status<300;
  return reply;
 }
};
