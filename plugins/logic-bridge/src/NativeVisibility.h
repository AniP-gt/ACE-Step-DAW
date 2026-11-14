#pragma once
#include <juce_core/juce_core.h>

#if JUCE_MAC
bool nativeViewIsVisible(void* handle);
#else
inline bool nativeViewIsVisible(void*) { return true; }
#endif
