/** Cleanup: database clusters in error. */
import { type CleanupContribution, Link, StatusDot, tr, useOsList } from "@rassvet/sdk";
import { type DbCluster, deleteCluster, engineLabel } from "./api";

type Row = DbCluster & { id: string };

export const cleanup: CleanupContribution = {
  useFindings: ({ base, idle, ageCol, table }) => {
    // dbaas-api lists the token's project only, in the admin view too.
    const clusters = useOsList<DbCluster>("ext:dbaas", "clusters", "clusters");
    const failed = clusters.data?.filter((c) => c.status === "error" && idle(c.created_at)).map((c): Row => ({ ...c, id: c.name }));
    return [
      {
        id: "failed-db-clusters",
        icon: "database",
        title: tr("Database clusters in error"),
        hint: tr("DBaaS clusters that failed. Their members, storage, ports and load balancer still count against quota; deleting the cluster removes them."),
        count: failed?.length,
        loading: !failed,
        error: clusters.error,
        table: () =>
          table<Row>(
            "failed-db-clusters",
            failed,
            [
              {
                key: "name",
                header: tr("Name"),
                cell: (c) => (
                  <Link to={`${base}/clusters/${c.name}`} className="truncate font-medium text-cable hover:underline">
                    {c.name}
                  </Link>
                ),
                value: (c) => c.name,
              },
              { key: "engine", header: tr("Engine"), width: "9rem", cell: (c) => engineLabel(c.engine), value: (c) => c.engine },
              { key: "status", header: tr("Status"), width: "14rem", wrap: true, cell: (c) => <StatusDot status="error" label={c.status_reason || c.status} />, value: (c) => `${c.status} ${c.status_reason ?? ""}` },
              ageCol<Row>(tr("Age"), (c) => c.created_at),
            ],
            (c) => c.name,
            [
              {
                id: "delete",
                label: tr("Delete"),
                icon: "trash",
                danger: true,
                title: tr("Delete database clusters?"),
                body: tr("Each cluster is deleted with its data, backups, ports, load balancer and security group."),
                past: tr("deleted"),
                run: (c) => deleteCluster(c),
              },
            ],
            () => clusters.refetch(),
            tr("clusters"),
          ),
      },
    ];
  },
};
