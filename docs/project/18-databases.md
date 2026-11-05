# Database clusters (DBaaS)

## Use case

An application needs MongoDB, MySQL or PostgreSQL with replication, backups and point-in-time recovery, but
nobody on the team wants to run database servers. Rassvet shows **Database → Database clusters** when the
cloud runs *DBaaS on Genestack* (catalog service type `dbaas`). The cloud runs the database members for you;
they are reachable only on a network of your project, like your own instances.

## Create a cluster

1. Go to **Database → Database clusters** and click **Create database** (or press Ctrl/⌘ K and choose
   *Create database cluster*).
2. **Engine**: a **Name** (up to 20 lowercase letters, digits and `-`; it can't be changed), the **Engine** and
   its **Version**.
3. **Size**: the **Flavor** (CPU and memory of each member), the number of **Members** (3 or more for high
   availability), the **Storage per member** in GB and, for MySQL / PostgreSQL, the number of proxies
   (HAProxy / PgBouncer).
4. **Network**: the **Network** and **Subnet** the database is reachable on. External networks and networks
   without port security aren't offered. For MySQL / PostgreSQL, **Floating IP** also publishes the load
   balancer outside. **Other allowed CIDRs** lets clients on other networks (behind a router or a VPN) in;
   the subnet itself is always allowed.
5. **Advanced** (optional): **engine parameters** (see [Engine parameters](#engine-parameters); the names
   are suggested from the catalog of the chosen version, with their type, range and the flavor's limit), and
   **Start from a backup** of another cluster of the same engine in this project (optionally to a point in
   time). A cluster started from a backup gets the parameters of the backup's cluster unless you set some.
6. Click **Create cluster**. The cluster shows *Creating* for a few minutes. The first cluster of an engine in a
   project also installs that engine's operator, which takes a few minutes more.

The project's DBaaS quota (clusters, CPU, memory, storage, ports, backups) is checked before anything is
created; the list page shows how many clusters are used.

## Members and addresses

The **Overview** tab lists the cluster's instances:

- **Members**: the database pods (PostgreSQL's *Primary* and *Replicas*) and the HAProxy / PgBouncer pods,
  with their state, restarts and start time. **Restart** recreates one member's pod with the same volume
  and network port. DBaaS refuses it while a parameter change is applied, while the member is already
  restarting or still starting, and while another member of the same kind (database or proxy) isn't ready,
  so a restart never takes down more than one member. Restarting the primary hands over to a replica (writes
  stop for a few seconds); a one-member cluster is down until it is back. A member that isn't ready can
  always be restarted, to unstick it.
- **Switch primary** (PostgreSQL): makes a replica the primary, the first ready one or the one picked in the
  dialog (or **Make primary** on a replica's row); the old primary becomes a replica. Patroni switches within
  seconds and nothing restarts; writes pause briefly and clients reconnect through the load balancer. It is
  refused while a parameter change is applied, while the cluster isn't ready, without a ready replica, or when
  Patroni declines (its reason is shown). MySQL has no primary (every member accepts writes); for MongoDB,
  restarting the primary makes the replica set elect another one.
- **Addresses on your network**: MySQL and PostgreSQL have the load balancer address (and floating IP) and,
  for diagnosis and firewall rules, the address of each HAProxy / PgBouncer port. A PgBouncer row is a slot
  of its pool, held by any PgBouncer pod; a spare slot isn't ready. The database instances themselves run on
  DBaaS's own network and never have an address on the project's subnet. MongoDB lists one address per
  member.

## Connect

Open the cluster and choose the **Connect** tab:

- **MySQL / PostgreSQL**: one load balancer **Address** (and **Hostname**, **Floating IP**) and **Port**.
- **MongoDB**: one hostname and address per replica-set member, and a **CA certificate** to download: clients
  must use TLS with it.
- **URI** is a connection string without the password. Click **Show** under *Administrative user* to see the
  user name and password (needs the `member` or `admin` role); the URI then includes the user name.

Hostnames resolve through the network's internal DNS, so use them from instances on that network.

## Allowed networks and floating IP

The **Access** tab lists the extra CIDRs allowed to reach the database, one per line (at most 50). Save
applies them to the cluster's security group at once.

For MySQL and PostgreSQL, **Floating IP** turns a public address for the load balancer on or off at any
time. It is allocated on the cloud's external network within seconds and shown there and in *Connect*;
turning it off releases it (a new one may differ). Clients also need their CIDR in the allowed CIDRs: the
load balancer keeps their source address. A floating IP the cloud operator attached outside DBaaS is shown
as *external*: DBaaS neither manages nor removes it, and can't add its own. MongoDB has no floating IP.

## Scale, resize and delete

From the **⋯** menu:

- **Scale or resize** changes the number of members, the flavor, the storage (grow only) and the number of
  proxies. Members are replaced one at a time. A new flavor is checked against the parameters set for the
  cluster first: a flavor too small for them is refused with the parameters at fault.
- **Delete cluster** deletes the data, the ports, the load balancer, the security group **and the backups**.

## Backups and restores

The **Backups** tab:

- **Backup policy → On / Off**: the switch turns automatic backups (schedule and PITR) off in one step;
  backups already taken are kept until deleted and *Back up now* still works. Turning it on asks for the
  policy, starting from every day at 02:00 UTC.
- **Backup policy → Edit**: a schedule (presets or a 5-field cron in UTC, at most every 15 minutes), how many
  scheduled backups are kept, and **point-in-time recovery** (continuous oplog / binlog / WAL shipping).
  Turning backups or PITR on or off may restart the members once.
- **Back up now** takes a full backup (the cluster must be *Ready*).
- **Restore** overwrites the cluster's data in place from a backup, or, with PITR, to a point in time (the
  newest backup before it is used). Type the cluster's name to confirm. Addresses don't change; clients
  reconnect.
- The **Restores** table shows the progress of each restore.

When the cloud offers no backup storage the tab says so.

## Monitoring, logs and events

These tabs need the cloud's monitoring (they say so when it isn't offered):

- **Monitoring**: the state and role of every member (primary / secondary, synced, replica…) and charts for
  the last 15 minutes to 7 days: CPU, memory, disk used (of the volume size), connections, operations, network
  traffic on your network, replication lag or queue, cache hit ratio, and per engine queued operations
  (MongoDB), slow queries and row lock waits (MySQL) or deadlocks (PostgreSQL). Proxies appear in the CPU,
  memory and network charts. Click names in a legend to show only those members.
- **Logs**: the last lines of a member's database or proxy log. Choose the member, container, how many lines
  and since when; **Follow** refreshes every 5 seconds, **Before the last restart** reads the previous
  container's log. MongoDB connection and authentication lines are hidden unless switched on. Needs the
  `member` or `admin` role, since logs can contain data.
- **Events**: what Kubernetes reported about the cluster, its members, ports, backups and restores in the last
  hour (warnings first to look at when a cluster is *Degraded* or stuck).

## Slow queries

The **Queries** tab:

- **Slow query threshold → Change** (ms). MongoDB logs slower statements as *Slow query* and PostgreSQL as
  *duration: … statement: …* (see **Logs**; `-1` stops PostgreSQL logging statements, applied without a
  restart). MySQL counts them in the *Slow queries* chart. MongoDB and MySQL members restart one by one to
  apply it.
- **Busiest statements** (MySQL): normalized statements (literals replaced by `?`) of one member from
  `performance_schema`, by total time, average time, calls or rows examined. Needs the `member` or `admin`
  role.

## Engine parameters

The **Parameters** tab tunes the engine: PostgreSQL settings (`work_mem`, `random_page_cost`, …), MySQL
system variables (`wait_timeout`, `long_query_time`, …), MongoDB `mongod.conf` options and
`setParameter.<name>` values. Only what the cloud allows for the cluster's major version can be set.

- **Effective parameters**: what DBaaS writes into the configuration and where each value comes from:
  *DBaaS default*, *Flavor* (sized from the member memory, recomputed on resize), *Set by you*, *Cloud
  operator* (only an admin changes it) or *Locked* (required by DBaaS). Anything not listed keeps the engine's
  own default.
- **Change parameters**: add or change values (names and enum values are suggested, with type, range,
  default, the flavor's limit and whether the server restarts) and pick parameters to put back to their
  default. **Review changes** runs a dry run: every refused value is listed with its reason, otherwise the
  dialog shows each change and how it is applied, then **Apply** writes it:
  - *reload* (PostgreSQL): no restart;
  - *restart* (PostgreSQL parameters marked *Restart*): each member restarts in place, replicas first;
  - *rolling* (MySQL, MongoDB): members are recreated one at a time; a one-member cluster is down meanwhile.
- **Edit as text** (or the *Form / Text* switch in the dialog and in the create dialog's Advanced step): the
  parameters set for the cluster as a configuration file, one `name = value` per line, `#` comments. Change
  or add lines to set them, delete a line to put it back to its default. A postgresql.conf, a my.cnf
  (`[mysqld]` headers ignored, `wait-timeout` read as `wait_timeout`) or a mongod.conf (nested keys read as
  `operationProfiling.slowOpThresholdMs`) can be pasted or loaded from a file. Lines that can't be read, and
  names set twice, are marked in red; names missing from the catalog are marked in amber, and the review's
  refusals point at their line.
- **Apply now** or **Keep for later**: a change kept for later is checked like any other but nothing restarts.
  Changes kept for later add up (a later value replaces an earlier one) and the table shows them as
  *value → new value*. The tab's banner shows them with who changed them last; **Review and apply** checks
  them again against the cluster's current version and flavor and applies them as one change, **Discard**
  forgets them. A change can be kept for later even while another one is applied. A cluster restored from a
  backup gets the parameters in effect, not the pending ones.
- One change at a time: while one is applied the cluster shows *Updating* ("applying parameter change N")
  and other changes, rollbacks and resizes wait. If the engine stops starting because of a change, DBaaS
  writes the previous parameters back by itself and the tab shows the reason for an hour.
- **History**: the last 10 changes (who, what; admin changes are marked). **Roll back to this revision**
  shows what would change, then writes it as a new change.

The slow query threshold (Queries tab) is a shortcut for one of these parameters.

## Cleanup

**Operations → Cleanup** lists *Database clusters in error*, which still use quota until deleted.

## Locked projects

When the cloud operator locks a project, the list shows the reason: the clusters keep running and can be
read, but nothing can be created, changed or deleted until the project is unlocked.

## Administration

The admin view has **All database clusters** and **Database service** under *Database*. dbaas-api only
accepts admin requests from its configured admin projects (`admin.projects` in its config) or a
system-scoped token, with an admin role: work from such a project in Rassvet. The `admin` role of an
ordinary project is not a DBaaS admin.

- **All database clusters**: every project's clusters, with their project; `?project=<id>` (from
  *Database service*) shows one project's. Admins open a cluster on behalf of its project and can scale,
  back up, restore, change allowed CIDRs and the backup policy, read metrics, logs and events, or delete
  it. Creating clusters and reading database credentials stay with the project's own users.
- **Runtime** tab of a cluster (admins only): pods with their node and restarts, port claims with their
  Neutron port, IP and host, volumes, the load balancer, the attachment's conditions, the operator's
  status and members that don't come up with the Kubernetes detail. **Restart** deletes a pod (its
  operator recreates it with the same volume and port) with the project's checks; **Force** skips them, to
  unstick a cluster. The Overview's members also show each pod's node and pod IP. **Retry** asks dbaas-controller to reconcile a
  port claim that isn't bound.
- **Parameters** on behalf of the project: admins also set what the cloud keeps for operators (durability
  and resource parameters, shown as *Cloud operator*); the catalog shows which ones are admin-only. When a
  cluster's configuration isn't sized for its flavor (made before DBaaS sized configurations), the Runtime
  tab lists the parameters and **Apply sizing** writes the flavor's values (members restart).
- **Force delete** (cluster menu, only while a deletion is stuck): drops the finalizers of the database
  cluster and its operator resource and deletes the remaining pods; *Also release the network
  resources* leaves the Neutron ports, security group and load balancer to the garbage collector.
- **Database service**: projects that use DBaaS, their clusters by status and usage against quota.
  *Edit quota* sets overrides (an empty field uses the cloud default; a limit below usage only blocks new
  usage), *Reset quota* removes them, and *Lock project* takes a reason shown to the project's users.

Every admin request is written to dbaas-api's audit log.
