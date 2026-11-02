/**
 * Neutron's DNS integration: a DNS domain on networks, DNS names on ports and floating IPs,
 * from which Neutron publishes records in Designate. Everything here is shown only when the
 * cloud's Neutron has the `dns-integration` extension (the operator set
 * `external_dns_driver = designate` and the `dns_domain_ports` ML2 driver); elsewhere the
 * fields would be refused or do nothing.
 */
import { useQuery } from "@tanstack/react-query";
import { ComboInput } from "@/components/ComboInput";
import { Field } from "@/components/ui";
import { useNeutronExtensions } from "@/lib/neutron";
import { os } from "@/lib/os";
import { useNav } from "@/lib/session";
import { tr } from "@/lib/i18n";

/** Which DNS fields this cloud's Neutron takes. */
export function useNeutronDns() {
  const ext = useNeutronExtensions();
  const has = (a: string) => ext.data?.has(a) ?? false;
  return {
    /** dns_domain on networks, dns_name on ports and floating IPs. */
    on: has("dns-integration"),
    /** dns_domain on ports too. */
    portDomain: has("dns-domain-ports"),
  };
}

/** Designate zones of the project, as suggestions (only when the Designate extension is on). */
function useZoneNames() {
  const nav = useNav(true);
  const designate = nav.data?.extensions.some((e) => e.id === "designate") ?? false;
  return useQuery({
    queryKey: ["os", "ext:designate", "zones", "names"],
    queryFn: () => os.list<{ name: string }>("ext:designate", "zones", "zones").then((zs) => zs.map((z) => z.name)),
    enabled: designate,
    staleTime: 60_000,
  });
}

/** "app.example.com" → "app.example.com." (Neutron wants the trailing dot); empty stays empty. */
export function dnsDomain(v: string) {
  const s = v.trim();
  return s && !s.endsWith(".") ? `${s}.` : s;
}

/** Host name labels (RFC 1123), optionally dotted; Neutron refuses other characters. */
export const dnsNameOk = (v: string) => !v.trim() || /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.?$/i.test(v.trim());

export function DnsDomainField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint?: string }) {
  const zones = useZoneNames();
  const ok = dnsNameOk(value);
  return (
    <Field
      label={tr("DNS domain")}
      hint={
        !ok
          ? tr("Use letters, digits, hyphens and dots, e.g. app.example.com.")
          : (hint ?? tr("Neutron publishes the records of this network's ports in this Designate zone, e.g. web01.app.example.com. The zone must exist in Designate."))
      }
    >
      {() => (
        <ComboInput
          value={value}
          onChange={onChange}
          options={(zones.data ?? []).map((z) => ({ value: z }))}
          placeholder="app.example.com."
          aria-label={tr("DNS domain")}
          invalid={!ok}
          mono
        />
      )}
    </Field>
  );
}
