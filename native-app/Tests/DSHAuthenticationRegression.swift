import AppKit
import WebKit
@main struct DSHAuthenticationRegression {
 @MainActor static func main() {
  let target = URL(string:"http://127.0.0.1:3080/")!
  let samples = "dsh web: http://127.0.0.1:3080/?token=old\ndsh web: http://127.0.0.1:3080/?token=new\ndsh web: http://evil.example:3080/?token=bad\ndsh web: http://127.0.0.1:3080/?token=x&redirect=bad\ndsh web: http://user@127.0.0.1:3080/?token=bad"
  let urls = DSHWebAuthentication.launchURLs(in:samples,for:target)
  precondition(urls.count==2 && urls[0].query=="token=new")
  precondition(DSHWebAuthentication.launchURLs(in:samples,for:URL(string:"https://evil.example:3080/")!).isEmpty)
  precondition(DSHWebAuthentication.launchURLs(in:samples,for:URL(string:"http://127.0.0.1:18789/")!).isEmpty)
  print("PASS: launch-link parser rejects other origins, ports, userinfo and extra parameters")
  guard CommandLine.arguments.contains("--live") else { return }
  let app=NSApplication.shared
  app.setActivationPolicy(.prohibited)
  let holder=WebViewHolder()
  let view=holder.view(for:target)
  view.frame=NSRect(x:0,y:0,width:1000,height:800)
  Task { @MainActor in
   for _ in 0..<100 {
    try? await Task.sleep(nanoseconds:200_000_000)
    if let result=try? await view.evaluateJavaScript("document.body?.innerText || ''") as? String, result.count>100 && !result.contains("authentication required") && !result.contains("Failed to load plugins") {
     guard (try? await view.evaluateJavaScript("!!document.querySelector('textarea, [contenteditable=true], [role=textbox]')")) as? Bool == true else { continue }
     let cookies=await view.configuration.websiteDataStore.httpCookieStore.allCookies()
     guard cookies.contains(where:{$0.name.hasPrefix("dsh-auth-")}), view.url?.query==nil else { continue }
     print("PASS: WKWebView authenticated, received DSH cookie, returned to clean URL, rendered app")
     holder.dispose();exit(0)
    }
   }
   if let info = try? await view.evaluateJavaScript("JSON.stringify({title:document.title, chars:document.body?.innerText?.length, authError:document.body?.innerText?.includes('authentication required'), state:document.readyState})") { print(info) }
   let cookies = await view.configuration.websiteDataStore.httpCookieStore.allCookies(); print("Has DSH cookie:",cookies.contains(where:{$0.name.hasPrefix("dsh-auth-")}))
   print("FAIL: DSH did not load; has URL: \(view.url != nil), isLoading: \(view.isLoading)")
   holder.dispose();exit(1)
  }
  app.run()
 }
}
