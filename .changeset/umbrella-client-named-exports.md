---
'hypdriv': patch
---

`hypdriv/client` names its exports. It is a Client Component boundary, and Next.js with webpack (`next build --webpack`) refuses `export *` there, so an application that imported `VitalsReporter` or `HypDrivDevTools` from the umbrella package did not build with webpack.
