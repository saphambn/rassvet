import type { ExtensionUi } from "@rassvet/sdk";
import { Projects } from "./Admin";
import ClusterDetail from "./ClusterDetail";
import { cleanup } from "./cleanup";
import Clusters from "./Clusters";
import { palette } from "./palette";

const ui: ExtensionUi = {
  routes: [
    { path: "clusters", component: Clusters },
    { path: "clusters/:id", component: ClusterDetail },
    // Admin: projects (quota, locks) and any project's cluster, acted on on its behalf
    { path: "projects", component: Projects, adminOnly: true },
    { path: "projects/:project/clusters/:id", component: ClusterDetail, adminOnly: true },
  ],
  palette,
  cleanup,
};

export default ui;
