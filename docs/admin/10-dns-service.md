# DNS service (Designate)

## Use case

You run Designate and want to control which domains projects can create, give a project more zones, set up
TSIG keys for zone transfers, or check that the Designate services are up. The admin view has **DNS → All
DNS zones** and **DNS → DNS service** when the cloud has Designate.

## Zones of every project

**DNS → All DNS zones** lists every project's zones with a **Project** column (Rassvet sends Designate's
`X-Auth-All-Projects` header; the `in-addr.arpa` zones Designate keeps for floating IPs belong to its service
project). Open a zone to change its records on the owner's behalf. Admins can also:

- **Create zone** or **Import zone** for another project (the **Project** picker; Rassvet sends
  `X-Auth-Sudo-Project-ID`).
- **Abandon zone**: remove a zone from Designate's database only, leaving it on the DNS servers. Use it for a
  zone the backends no longer have or that you are migrating away; **Delete zone** removes it everywhere.

![All DNS zones](../images/admin/dns-zones.png)

## Which domains are allowed

On **DNS → DNS service**:

- **TLDs**: with none, any domain can be created. Once one exists (e.g. `com`, `org`, `co.uk`), only zones
  under a listed TLD are accepted.
- **Blacklists**: regular expressions of zone names projects may not create, e.g.
  `^([A-Za-z0-9_\-]+\.)*example\.com\.$` to reserve the cloud's own domain. The dialog lets you try a name
  against the pattern. Admins can still create blacklisted zones.

![DNS service: TLDs](../images/admin/dns-settings.png)

## Neutron DNS integration

Rassvet shows the DNS fields of networks, ports and floating IPs (see
[automatic records](../project/16-dns-zones.md#automatic-records-for-instances-neutron-dns-integration)) only
when Neutron lists the `dns-integration` extension (`dns-domain-ports` adds a domain per port). That needs, in
Neutron, `[DEFAULT] dns_domain` and `external_dns_driver = designate`, the `dns_domain_ports` ML2 extension
driver and a `[designate]` section with credentials for Designate. Without it the zone overview tells users that
records aren't created automatically.

## Quotas

Designate has no list of per-project quotas, so **Quotas** asks for a project first and shows its five limits:
zones, record sets per zone, records per zone, records per record set and export size. **Change** sets them
(`-1` = unlimited); **Reset to defaults** returns the project to the defaults in `designate.conf`
(`[DEFAULT] quota_*`).

## TSIG keys, pools and services

- **TSIG keys** sign zone transfers. Scope **Pool** is used between Designate and the DNS servers of a pool;
  scope **Zone** with the primaries of one secondary zone. A random base64 secret is filled in; configure the
  same name, algorithm and secret on the DNS servers.
- **Pools** lists the pools from `pools.yaml` (loaded with `designate-manage pool update`) and their name
  servers — the NS records every zone in the pool gets.
- **Services** shows each Designate service (api, central, worker, producer, mdns…) per host with its status and
  last heartbeat. Designate keeps the last status of a host that stopped reporting (for example a pod that was
  replaced), so Rassvet shows hosts without a heartbeat for 2 minutes as *No heartbeat*. A service that is
  *DOWN* or has no live host explains zones stuck in *Pending*.

  ![Designate services](../images/admin/dns-services.png)
