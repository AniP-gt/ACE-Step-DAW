#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include "ResultCatalogState.h"

class CatalogLookAndFeel final : public juce::LookAndFeel_V4 {
public:
 void drawButtonText(juce::Graphics& g,juce::TextButton& button,bool highlighted,bool down) override {
  if(button.isEnabled()){juce::LookAndFeel_V4::drawButtonText(g,button,highlighted,down);return;}
  const auto font=getTextButtonFont(button,button.getHeight());g.setFont(font);
  g.setColour(button.findColour(button.getToggleState()?juce::TextButton::textColourOnId:juce::TextButton::textColourOffId).withMultipliedAlpha(0.6f));
  const int y=juce::jmin(4,button.proportionOfHeight(0.3f));const int corner=juce::jmin(button.getHeight(),button.getWidth())/2;
  const int fontHeight=juce::roundToInt(font.getHeight()*0.6f);
  const int left=juce::jmin(fontHeight,2+corner/(button.isConnectedOnLeft()?4:2));
  const int right=juce::jmin(fontHeight,2+corner/(button.isConnectedOnRight()?4:2));
  g.drawFittedText(button.getButtonText(),left,y,button.getWidth()-left-right,button.getHeight()-2*y,juce::Justification::centred,2);
 }
};

class CatalogFocusList final : public juce::ListBox {
public:
 CatalogFocusList(const juce::String& name,juce::ListBoxModel* model):juce::ListBox(name,model) {}
 void paintOverChildren(juce::Graphics& g) override {if(hasKeyboardFocus(true)){g.setColour(findColour(juce::TextEditor::focusedOutlineColourId));g.drawRect(getLocalBounds(),2);}}
 void focusGained(FocusChangeType cause) override {juce::ListBox::focusGained(cause);repaint();}
 void focusLost(FocusChangeType cause) override {juce::ListBox::focusLost(cause);repaint();}
};

class ResultCatalogView final : public juce::Component, private juce::ListBoxModel {
public:
 using Page = ResultCatalogState::Page;
 std::function<void()> refresh, latest, dismiss;
 std::function<void(const std::string&)> older;
 std::function<void(const juce::String&)> fetch;
 ResultCatalogView() : list("Results", this), refreshButton("Refresh"), olderButton("Older"), latestButton("Latest"), dismissButton("Dismiss"), fetchButton("Fetch selected") {
  for(auto* c:std::initializer_list<juce::Component*>{&heading,&state,&notice,&list,&refreshButton,&olderButton,&latestButton,&dismissButton,&fetchButton}) addAndMakeVisible(c);
  heading.setText("Results",juce::dontSendNotification);heading.setFont(juce::FontOptions(17.0f,juce::Font::bold));
  list.setRowHeight(38);list.setWantsKeyboardFocus(true);list.setTitle("Available results");
  refreshButton.onClick=[this]{if(refresh)refresh();};olderButton.onClick=[this]{if(older)older(page.nextBeforeResultId);};
  latestButton.onClick=[this]{if(latest)latest();};dismissButton.onClick=[this]{if(dismiss)dismiss();};
  fetchButton.onClick=[this]{if(canFetch() && fetch)fetch(selected);};
 }
 void update(Page next,bool paired,bool inFlight,bool baseline,bool showNotice,bool stale,int retrySeconds,bool busy) {
  canUseFetch=paired && !busy;page=std::move(next);list.updateContent();
  int index=-1;for(int i=0;i<getNumRows();++i)if(juce::String(page.results[static_cast<size_t>(i)].resultId)==selected){index=i;break;}
  if(index>=0)list.selectRow(index,false,false);else list.deselectAllRows();
  state.setText(!paired?"Pair to see results":stale?"Results may be stale. Retry in "+juce::String(retrySeconds)+" seconds":inFlight?"Loading results...":!baseline?"Waiting for results":page.results.empty()?"No results available":"Select a result, then Fetch",juce::dontSendNotification);
  notice.setText(showNotice?"New results available":"",juce::dontSendNotification);dismissButton.setVisible(showNotice);
  refreshButton.setEnabled(paired);latestButton.setEnabled(paired);olderButton.setEnabled(paired && !page.nextBeforeResultId.empty());
  fetchButton.setEnabled(canFetch());
 }
 void resized() override {
  auto b=getLocalBounds();heading.setBounds(b.removeFromTop(26));state.setBounds(b.removeFromTop(25));
  auto n=b.removeFromTop(30);dismissButton.setBounds(n.removeFromRight(90));notice.setBounds(n);
  auto row=b.removeFromTop(34);refreshButton.setBounds(row.removeFromLeft(100).reduced(2));olderButton.setBounds(row.removeFromLeft(90).reduced(2));latestButton.setBounds(row.removeFromLeft(90).reduced(2));
  b.removeFromTop(6);fetchButton.setBounds(b.removeFromBottom(36).removeFromRight(140).reduced(2));b.removeFromBottom(6);list.setBounds(b);
 }
private:
 Page page;juce::String selected;bool canUseFetch=false;juce::Label heading,state,notice;CatalogFocusList list;juce::TextButton refreshButton,olderButton,latestButton,dismissButton,fetchButton;
 bool canFetch() const {return canUseFetch && list.getSelectedRow()>=0 && selected.isNotEmpty();}
 int getNumRows() override {return static_cast<int>(page.results.size());}
 juce::String rowText(int row,bool full) const {const auto& r=page.results[static_cast<size_t>(row)];auto id=juce::String(r.resultId);return juce::String(r.instrument)+"  |  "+juce::String(static_cast<double>(r.frameCount)/48000.0,2)+" s  |  "+(r.placementSeconds>=0?"+":"")+juce::String(r.placementSeconds,2)+" s  |  "+(full?id:id.substring(0,8));}
 juce::String getNameForRow(int row) override {return row>=0 && row<getNumRows()?rowText(row,true):juce::String();}
 void paintListBoxItem(int row,juce::Graphics& g,int width,int height,bool selectedRow) override {
  if(row<0 || row>=getNumRows())return;
  if(selectedRow)g.fillAll(list.findColour(juce::ListBox::textColourId).withAlpha(0.2f));
  g.setColour(list.findColour(juce::ListBox::textColourId));g.setFont(14.0f);
  const auto& item=page.results[static_cast<size_t>(row)];
  g.drawFittedText(juce::String(item.instrument),8,1,width-16,height/2,juce::Justification::centredLeft,1);
  auto details=juce::String(static_cast<double>(item.frameCount)/48000.0,2)+" s  |  "+(item.placementSeconds>=0?"+":"")+juce::String(item.placementSeconds,2)+" s  |  "+juce::String(item.resultId).substring(0,8);
  g.drawFittedText(details,8,height/2,width-16,height/2,juce::Justification::centredLeft,1);
 }
 void selectedRowsChanged(int row) override {if(row>=0 && row<getNumRows())selected=juce::String(page.results[static_cast<size_t>(row)].resultId);fetchButton.setEnabled(canFetch());}
};
