// SPDX-License-Identifier: AGPL-3.0-or-later
//! Plugin registration barrel. Importing this module once (from `main.tsx`,
//! before first render) runs each plugin's `index.ts` side effect, registering
//! its contributions with the registry. Add a line here for each compiled-in
//! plugin.

import "@/plugins/core";
import "@/plugins/texturing";
import "@/plugins/music";
