#include <jni.h>
#include "BridgeKitOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::BridgeKit::initialize(vm);
}
