package co.logos.perun.video

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class PerunVideoPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
    listOf(PerunVideoModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
