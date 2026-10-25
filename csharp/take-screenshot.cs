// Drop-in C# action for LuaSTGMcpBridge: returns the editor window as a Base64 PNG.
//
// Install (one time, needs a bridge rebuild):
//   1. copy this file to  LuaSTG-Editor-Sharp-X-main/LuaSTGMcpBridge/Actions/ScreenshotActions.cs
//   2. add it to LuaSTGMcpBridge.csproj:   <Compile Include="Actions\ScreenshotActions.cs" />
//   3. register it in BridgeHost.CreateRouter(), next to the other actions:
//        router.Register("take_screenshot", request => ScreenshotActions.TakeScreenshot(request));
//   4. rebuild LuaSTGMcpBridge and restart the editor.
//
// Protocol:
//   request   {"action":"take_screenshot"}            (optional "format":"png")
//   response  {"status":"ok","format":"png","imageBase64":"…","width":W,"height":H,"bytes":N,"window":"title"}
//   failure   {"status":"failure","error":"…","details":{…}}
//
// The image never touches the disk: the PNG is encoded into a MemoryStream and comes back as
// Base64, so the TS side can hand it straight to the caller and there is nothing to clean up.
//
// RenderTargetBitmap renders the WPF visual tree, so the capture is unaffected by other windows
// covering the editor — but it still needs the window to be laid out, hence the minimized check.
using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using LuaSTGMcpBridge.Protocol;
using LuaSTGMcpBridge.Threading;
using Newtonsoft.Json.Linq;

namespace LuaSTGMcpBridge.Actions
{
    /// <summary>
    /// Screenshot action: renders the editor's main window into a PNG and returns it as Base64.
    /// </summary>
    public static class ScreenshotActions
    {
        /// <summary>
        /// Handles <c>take_screenshot</c>.
        /// </summary>
        /// <param name="request">The bridge request; no arguments are required.</param>
        /// <returns>The response object described at the top of this file.</returns>
        public static JObject TakeScreenshot(JObject request)
        {
            return Guard(() => UiThread.Invoke(() =>
            {
                Window window = Application.Current == null ? null : Application.Current.MainWindow;

                if (window == null)
                    return BridgeProtocol.Failure("the editor has no main window", "no_window");

                if (window.WindowState == WindowState.Minimized)
                {
                    return BridgeProtocol.Failure(
                        "the editor window is minimized; restore it before taking a screenshot",
                        "window_minimized",
                        new JObject { ["window"] = window.Title ?? "" });
                }

                // Render at the window's real DPI, otherwise the PNG is blurry on scaled displays.
                DpiScale dpi = VisualTreeHelper.GetDpi(window);
                int width = (int)Math.Ceiling(window.ActualWidth * dpi.DpiScaleX);
                int height = (int)Math.Ceiling(window.ActualHeight * dpi.DpiScaleY);

                if (width <= 0 || height <= 0)
                {
                    return BridgeProtocol.Failure(
                        "the editor window has no size yet",
                        "window_not_ready",
                        new JObject { ["width"] = width, ["height"] = height });
                }

                RenderTargetBitmap bitmap = new RenderTargetBitmap(
                    width, height, 96.0 * dpi.DpiScaleX, 96.0 * dpi.DpiScaleY, PixelFormats.Pbgra32);
                bitmap.Render(window);

                PngBitmapEncoder encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(bitmap));

                byte[] bytes;

                using (MemoryStream stream = new MemoryStream())
                {
                    encoder.Save(stream);
                    bytes = stream.ToArray();
                }

                return new JObject
                {
                    ["status"] = "ok",
                    ["format"] = "png",
                    ["imageBase64"] = Convert.ToBase64String(bytes),
                    ["width"] = width,
                    ["height"] = height,
                    ["bytes"] = bytes.Length,
                    ["window"] = window.Title ?? ""
                };
            }));
        }

        /// <summary>
        /// Turns any exception into a bridge failure so a broken render can never kill the editor.
        /// </summary>
        /// <param name="handler">The guarded handler.</param>
        /// <returns>The handler result, or a failure response.</returns>
        private static JObject Guard(Func<JObject> handler)
        {
            try
            {
                return handler();
            }
            catch (Exception ex)
            {
                try
                {
                    BridgeFileLog.CreateLogger("McpScreenshotActions")
                        .Error(ex, "MCP bridge action take_screenshot failed.");
                }
                catch (Exception)
                {
                }

                return BridgeProtocol.Failure("internal error in 'take_screenshot': " + ex.Message, "error");
            }
        }
    }
}
