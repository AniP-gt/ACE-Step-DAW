#include "NativeVisibility.h"
#import <Cocoa/Cocoa.h>

bool nativeViewIsVisible(void* handle) {
 NSView* view=(NSView*)handle;
 if(view==nil)return false;
 NSWindow* window=[view window];
 return window!=nil && [window isVisible] && ![window isMiniaturized] && ![view isHiddenOrHasHiddenAncestor];
}
