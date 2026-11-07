#pragma once
#include <juce_gui_basics/juce_gui_basics.h>

class ResultDragButton final : public juce::TextButton {
public:
 using FileProvider = std::function<juce::File()>;
 using DragStarter = std::function<bool(const juce::StringArray&,bool,juce::Component*)>;
 explicit ResultDragButton(FileProvider provider,DragStarter starter=[](const juce::StringArray& files,bool canMove,juce::Component* source) {
  return juce::DragAndDropContainer::performExternalDragDropOfFiles(files,canMove,source);
 }):TextButton("Drag WAV"),fileProvider(std::move(provider)),startDrag(std::move(starter)) {
  setTooltip("Drag the WAV into Logic. Use Reveal in Finder for keyboard access.");
 }
 void mouseDown(const juce::MouseEvent& event) override {
  gestureActive=isEnabled() && event.mods.isLeftButtonDown();
  attempted=false;
  TextButton::mouseDown(event);
 }
 void mouseDrag(const juce::MouseEvent& event) override {
  TextButton::mouseDrag(event);
  if(!gestureActive || attempted || !isEnabled() || !event.mods.isLeftButtonDown() || event.getDistanceFromDragStart()<5)return;
  const auto file=fileProvider();
  if(!file.existsAsFile())return;
  attempted=true;
  if(!startDrag({file.getFullPathName()},false,this))setTooltip("Drag could not start. Use Reveal in Finder.");
 }
 void mouseUp(const juce::MouseEvent& event) override {
  gestureActive=false;
  TextButton::mouseUp(event);
 }
private:
 FileProvider fileProvider;
 DragStarter startDrag;
 bool gestureActive=false,attempted=false;
};
