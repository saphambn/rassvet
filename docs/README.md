# Rassvet user guide

Rassvet is a single-binary dashboard for OpenStack. This guide explains how to use it, one task at a time.
Each page starts with the **use case** (who needs it and why), then gives **step-by-step** instructions.

- **Project guides** — for everyone who works inside a project: [`project/`](project/)
- **Admin guides** — for users with the `admin` role who run the cloud: [`admin/`](admin/)

Screenshots were taken against a lab cloud; names, sizes and addresses on your cloud will differ.
Menu entries only appear when your cloud offers the service (for example, *Object storage* needs Swift or
Ceph RGW, *Load balancers* needs Octavia, *Kubernetes clusters* needs Magnum, *DNS zones* needs Designate) and when your role is allowed to use it.

## Project guides

| # | Guide | You will learn to |
|---|-------|-------------------|
| 1 | [Getting started](project/01-getting-started.md) | sign in, find your way around, work with several clouds, switch project and region, use the command palette |
| 2 | [Launch an instance](project/02-launch-instance.md) | create a virtual machine with the launch wizard |
| 3 | [Work with instances](project/03-manage-instances.md) | open the console, add a public IP, attach a volume, snapshot, resize, stop and delete |
| 4 | [Key pairs](project/04-key-pairs.md) | create or import an SSH key and log in to an instance |
| 5 | [Volumes](project/05-volumes.md) | create, attach, extend, snapshot, back up and hand over block storage |
| 6 | [Networks and routers](project/06-networks-and-routers.md) | build a private network with internet access and read the topology |
| 7 | [Security groups](project/07-security-groups.md) | open ports such as SSH or HTTPS |
| 8 | [Floating IPs](project/08-floating-ips.md) | allocate, associate and release public addresses |
| 9 | [Images](project/09-images.md) | upload your own image and share it |
| 10 | [Object storage and S3](project/10-object-storage.md) | store files in containers and use S3 tools |
| 11 | [Load balancers](project/11-load-balancers.md) | spread traffic over several instances |
| 12 | [API access](project/12-api-access.md) | use the `openstack` CLI, scripts and CI with application credentials |
| 13 | [Cleanup](project/13-cleanup.md) | find and remove leftovers that waste quota |
| 14 | [Export to Terraform](project/14-export-to-terraform.md) | turn resources you built by hand into code |
| 15 | [Kubernetes clusters](project/15-kubernetes-clusters.md) | create a Kubernetes cluster, connect with kubectl, resize and upgrade it |
| 16 | [DNS zones](project/16-dns-zones.md) | host a domain's records, import / export zone files, set reverse DNS of floating IPs, automatic records for instances (DNS domain of a network) |

## Admin guides

| # | Guide | You will learn to |
|---|-------|-------------------|
| 1 | [The admin view](admin/01-admin-view.md) | switch to the admin view and read the cloud overview |
| 2 | [Projects, users and quotas](admin/02-projects-users-quotas.md) | onboard a team: project, users, roles and limits |
| 3 | [Flavors](admin/03-flavors.md) | offer instance sizes, including confidential computing, vGPU and vTPM |
| 4 | [Hypervisors and host maintenance](admin/04-hypervisors-host-maintenance.md) | check capacity, drain a host for maintenance, evacuate a failed host |
| 5 | [Aggregates, zones and compute services](admin/05-aggregates-zones-services.md) | group hosts, publish availability zones, manage nova-compute services |
| 6 | [Provider networks](admin/06-provider-networks.md) | create external and shared networks |
| 7 | [Volume types and storage](admin/07-volume-types-storage.md) | offer storage tiers and watch backend capacity |
| 8 | [Cleanup across projects](admin/08-cleanup-all-projects.md) | find leftovers in every project |
| 9 | [Kubernetes service](admin/09-kubernetes-service.md) | publish cluster templates, set cluster quotas, check the Magnum services |
| 10 | [DNS service](admin/10-dns-service.md) | allow domains (TLDs, blacklists), set DNS quotas, TSIG keys, check the Designate services |

## Features

**Project view** (every user)
- Application credentials: create (roles, expiry, unrestricted), delete; secret shown once with ready-to-use `clouds.yaml` / OpenRC.
- API access: service endpoints by region/interface, `clouds.yaml` and OpenRC for the current project (copy or download).
- Change password (signs the user out everywhere).

- Images (Glance): list this project's, shared-with-me (accept/reject), public and community images; create from a file
  (streamed upload with a progress tray, uses `glance-direct` import when enabled) or from a URL (`web-download`);
  edit attributes and tags; edit metadata with a Horizon-style editor driven by Glance's metadata definitions
  catalog (the cloud's own, or Glance's standard catalog bundled in `crates/server/metadefs/` when the cloud has
  none loaded); share with projects; download; delete.
- Instances (Nova): list with status, IPs, flavor and boot type; start/stop/reboot/delete in bulk. Launch wizard
  (details, source, flavor, networks & ports, security groups, data volumes, key pair, cloud-init user data, config
  drive, review with quota impact) with search on every list. **Instances boot from a new Cinder volume by default**
  (image → volume, size defaults to the image's min_disk or 10 GiB, choice of volume type, deleted with the
  instance unless turned off); booting from an existing bootable volume or a volume snapshot, or from the
  hypervisor's local disk, is also offered; the root disk bus (virtio, scsi, sata, …) can be chosen. Several
  interfaces in order: new ports on networks (optional fixed IP and their own security groups, otherwise the
  instance's) or existing ports whose security groups are set before boot. Ports Rassvet creates for
  per-interface security groups are deleted with the instance when it is deleted from Rassvet. Extra data
  volumes: existing, new blank or new from an image (an ISO becomes a CD-ROM), each with an optional device
  name (/dev/vdb), disk bus and device type (disk, cdrom, floppy, lun).
  Instance detail tabs: Overview (Horizon-style info, specs, IP addresses, security groups with their rules,
  metadata, and for admins the hypervisor, host and instance name), Interfaces (edit security groups or the port,
  floating IPs, attach/detach), Volumes, Log, Console (noVNC embedded in the page) and Action log.
- Every resource row has a ⋮ menu with its actions, and detail pages have the same set under "Actions".
  Instances: edit, attach/detach volume and interface, security groups, floating IPs, snapshot, start/stop, soft
  and hard reboot, pause, suspend, shelve, lock, resize (confirm/revert), rebuild, rescue; admins also live
  migrate, migrate and reset state.
- Scheduling at launch: server group (with a "new server group" shortcut), keep away from / together with chosen
  instances (`different_host` / `same_host`) and custom scheduler hints (e.g. `query` for JsonFilter). Instance
  metadata with the Horizon-style editor, using Glance's metadata definitions for `OS::Nova::Server`
  (`properties_target: metadata`); metadata stays editable afterwards ("Edit metadata"). The instance overview shows
  its server group. Server groups page: create (affinity, anti-affinity with max per host, soft variants), list
  members, launch into a group, delete.
- Key pairs: create (Rassvet generates an Ed25519 or RSA key, imports the public half into Nova and hands you the
  private key once as a `.pem` download; it is never stored), import a public key, view, copy and delete.
- Volumes (Cinder): Horizon-like list (size, status, type, "/dev/vdb on instance", zone, bootable, encrypted);
  create empty, from an image, from a snapshot or as a copy; edit, extend, attach/detach, snapshot, upload to
  image, change type, launch an instance from it, bootable flag, delete; admins can reset the status. Volume
  snapshots: create a volume or launch from one, edit, delete.
- Volume backups: full or incremental, from the live volume (forced when attached) or from a snapshot; restore
  into a new volume or over an existing one, edit, delete (refused while newer incrementals depend on it). Each
  volume page has a Backups tab.
- Volume groups: create (group type, volume types, zone) like Horizon, or from a group snapshot or as a clone;
  add/remove member volumes, create volumes inside the group, group snapshots (consistent when the group type
  enables it), delete with or without the member volumes.
- Volume transfers: hand a volume to another project. The transfer ID and auth key are shown once (copy or
  download); the receiving project accepts them from Volumes or Transfers; pending transfers can be cancelled.
- Networking (Neutron): network detail with Overview, Subnets and Ports tabs (search, create, edit, delete;
  subnets with gateway, DHCP, DNS, allocation pools and host routes; ports with fixed IP, port security and
  security groups); routers (edit, gateway, connect/disconnect subnets); security groups with rules (presets for
  SSH, HTTP(S), DNS, databases, VPNs, ICMP, …); floating IPs (allocate, associate, move, release).
- Network topology in three views: Graph (force layout, networks as hubs wrapped in translucent hulls, drag
  nodes to arrange), Diagram (networks as vertical bars, devices as rows with a line and IP per port, trunk VLANs
  dashed) and 3D (three.js: glassy network spheres, traffic particles, orbit/zoom/pan; loaded on demand). Mouse
  wheel and trackpad pinch zoom, drag or two-finger scroll pans, full-screen mode, labels toggle, export SVG
  (PNG for 3D); optional DHCP and unattached ports; a Port map table lists every device ↔ network ↔ IP ↔ MAC.
- Trunks (VLAN-aware instances): create with a new or existing parent port and sub-ports (new port on a network
  with the parent's MAC, or an existing free port; VLAN ID or inherit), add/remove sub-ports, edit, delete.
- QoS policies: bandwidth limit, minimum bandwidth, DSCP marking, packet rate rules (per direction); apply to
  networks or ports (also from the network and port edit dialogs); project default policy. Neutron's policy
  decides who may create them (admins by default).
- Sharing (RBAC): share a network, QoS policy or security group with a chosen project (picker or pasted project
  ID); admins can share with all projects or offer a network as external. Network detail has a Sharing tab.
- Subnet pools and address scopes: create pools (prefixes, default prefix length, quotas), allocate subnets from a
  pool instead of typing a CIDR, onboard existing subnets.
- Load balancers (Octavia extension): create a complete load balancer in one dialog (VIP, listener, pool,
  members, health monitor), then manage listeners, L7 policies, pools and members.
- Kubernetes clusters (Magnum extension, Cluster API driver `magnum-capi-helm`): cluster templates (create,
  edit, clone, labels with suggestions), clusters (create, resize, upgrade to another template, renew the cloud
  credentials, delete), node groups (add, change the
  node count, autoscaler bounds) and a one-click kubeconfig (client certificate signed by the cluster CA, or
  OpenStack token sign-in), with links to the cluster's servers, network and API load balancer.
- DNS zones (Designate extension): zones (primary or secondary), record sets with per-type hints and checks
  (A, AAAA, CNAME, MX, TXT with automatic quoting, SRV, CAA, NS, PTR, SSHFP…), name servers to set at the
  registrar, zone file import and export, transfers to another project (request ID + key), shares with other
  projects (2023.1+), and reverse DNS (PTR) of floating IPs. Where Neutron is integrated with Designate: DNS
  domain of networks, DNS names of ports and floating IPs, and the networks publishing into each zone.
- Object storage (Swift API — OpenStack Swift or Ceph RGW): containers (public or private, storage policy,
  versioning, quotas, metadata), a file browser with folders, drag-and-drop uploads, downloads, properties,
  copy/move and temporary links. EC2 credentials give S3 tools (aws, s3cmd, rclone, boto3) access, with ready
  configuration snippets.
- Key manager (Barbican): secrets (store, generate, view payload), secret containers, orders and ACLs.
- Several clouds in one session: sign in to another cloud from the top bar and switch between them without
  signing in again; each browser tab can work on a different cloud.
- Command palette (Ctrl/⌘ K): jump to any page, run quick actions (launch, create, switch cloud, project,
  region or view, theme, language) and find any resource (instances, volumes, snapshots, backups, networks,
  subnets, ports, floating IPs, secrets, containers, load balancers, DNS zones, Kubernetes clusters…) by name
  or pasted ID.
- Cleanup: finds unattached volumes, volumes in error, old snapshots, unused floating IPs, detached ports,
  unused security groups, instances in error or stopped for long, empty routers, networks without ports,
  failed Kubernetes clusters and unused cluster templates, load balancers in error or without listeners, DNS
  zones in error, and removes them in bulk.
- Export to Terraform: pick resources (including Kubernetes clusters and templates) and get `main.tf` for the OpenStack provider, with resources you don't
  export looked up by name and optional `import` blocks to adopt what already exists.
- Overview: quota usage for Nova, Cinder and Neutron.
- Usage: the project's compute usage over a date range (active instances and RAM, vCPU-, disk GB- and RAM
  GiB-hours, per-instance table) with a CSV summary download, like Horizon's Usage page.

**Admin view** (users with the `admin` role; switch with Project / Admin in the sidebar)
- Overview: identity and image summaries, services per region, quick create.
- Images: every image in the cloud, filter by owner/status/hidden; deactivate and reactivate.
- Instances across all projects; flavors (create, delete, description, extra specs with suggested keys,
  ready-made presets for AMD SEV / SEV-ES / SEV-SNP, Intel TDX, vGPU, vTPM and Secure Boot, project access for
  private flavors); hypervisors with allocated capacity from Placement and host maintenance (start/end
  maintenance, drain a host with live and cold migration, evacuate a host that is down); host aggregates
  (availability zone, hosts, metadata); compute services (enable/disable with a reason, force down, delete);
  usage of every project or one project over a date range, with CSV.
- Quotas: per-project limits for Nova, Neutron and Cinder with current usage, unlimited switch and reset to
  defaults; default quotas (Nova/Cinder quota classes). Also reachable from the Projects row menu.
- Floating IPs of every project (allocate for any project, optionally a specific address; associate with that
  project's instances; release) and NDP proxies (publish an internal IPv6 address through a router; enables
  `enable_ndp_proxy` on the router when needed).
- Network: all networks (create provider networks: flat/VLAN/VXLAN…, physical network, segmentation ID,
  external, shared, owner project) and all routers; network agents (enable/disable, describe, delete, routers
  hosted by L3 agents and networks by DHCP agents with add/remove/move); IP availability per network; all QoS
  and RBAC policies. Router and network detail pages show their L3 / DHCP agents to admins.
- Volume groups and group snapshots of every project (same actions as the project pages, plus reset status).
- Storage: all volumes and all backups across projects (reset status, force delete); volume types with a detail
  page for extra specs (suggested keys), project access for private types, QoS association and encryption
  (LUKS, Barbican keys); QoS specs (front-end/back-end limits, associate with types); group types and group
  specs; storage backends (Cinder services and pool capacity, thin provisioning, over-subscription).
- Projects: list, create, edit, enable/disable, delete; members with roles (add, edit, remove).
- Users: list, create (optionally straight into a project with a role), edit, enable/disable, reset password, delete; project roles; their application credentials.
- Roles: list, create, rename, delete.
- Services & endpoints: everything registered in Keystone, filtered by region and interface (the user's API
  access page shows only public endpoints).
- Domains (create, edit, enable/disable, delete) and regions (with parent regions).
- Cleanup across every project, key manager quotas and object storage accounts of any project.
- Kubernetes (Magnum): clusters and templates of every project, public / hidden templates, cluster quotas per
  project, usage and the state of the Magnum services.
- DNS (Designate): zones of every project (create or import for another project, abandon), TLDs, blacklists,
  per-project DNS quotas, TSIG keys, pools and the state of the Designate services.
- Federation (SSO): identity providers (remote IDs, domain, authorization TTL) and their protocols (openid,
  saml2, mapped, x509), mappings edited as JSON with templates and validation, Keystone-to-Keystone service
  providers. Rassvet manages federation; signing in to Rassvet itself through SSO is not built yet.

Large lists: instances, volumes, snapshots, backups, routers, floating IPs and admin networks are fetched one
page at a time (`limit` = rows per page, `marker` = last row; First / Prev / Next, no total count). A field
picker filters on the server (name, project, host / hypervisor, status, IP, flavor, zone, volume, network
type…, or a full ID) and sortable columns sort on the server. Every table remembers its last filter and sort
for the rest of the login (kept in the session, so in memcached when configured): leave a page and come back,
and the same view is shown. Keystone has no paging: small user and project lists filter on
any column in the browser, and when Keystone truncates them (`list_limit`) names are searched on the server.
Tables drop their least important columns to fit their own width and scroll sideways only when even that won't fit.

Nova, Neutron, Cinder and Placement are reached through an allow-listed gateway (`/api/os/{service}/…`):
only the paths and server/volume actions Rassvet uses are forwarded, cloud-wide queries and admin actions need
the admin role, and microversions are negotiated per cloud and region (Nova up to 2.100, Cinder 3.70,
Placement 1.39).

Dropdowns are searchable pickers (keyboard friendly, grouped options, multi-select with chips) and menus
open with a short animation.

**Every list** has filtering, sorting, pagination (10/20/50/100 rows, remembered), a column chooser, CSV export
and refresh. Lists with actions support multi-select (shift-click for a range, "select all N") and bulk actions
(delete, enable/disable, deactivate/reactivate, accept/reject) with a confirmation that lists skipped items and
reports per-item failures.
