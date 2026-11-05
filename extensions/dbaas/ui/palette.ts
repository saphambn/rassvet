/** Command palette: "Create database" and the database clusters (the project's, or every project's for admins). */
import { type PaletteContribution, os, tr } from "@rassvet/sdk";
import type { DbCluster } from "./api";

const kind = {
  kind: tr("Database cluster"),
  aliases: ["database", "db", "dbaas"],
  icon: "database",
  // Clusters are named, not numbered; admin rows carry their project.
  id: (r: DbCluster) => (r.project_id ? `${r.project_id}/${r.name}` : r.name),
};

export const palette: PaletteContribution = {
  keywords: "dbaas database db mongodb mongo mysql postgresql postgres pg",
  actions: [{ id: "new-cluster", label: tr("Create database cluster"), icon: "database", path: "clusters?new=1", keywords: "dbaas database mongodb mysql postgresql" }],
  resources: [
    {
      ...kind,
      view: "project",
      list: () => os.list<DbCluster>("ext:dbaas", "clusters", "clusters"),
      path: (r: DbCluster, c) => `${c.base}/clusters/${r.name}`,
    },
    {
      ...kind,
      view: "admin",
      list: () => os.list<DbCluster>("ext:dbaas", "admin/clusters", "clusters"),
      path: (r: DbCluster, c) => `${c.base}/projects/${r.project_id}/clusters/${r.name}`,
    },
  ],
};
