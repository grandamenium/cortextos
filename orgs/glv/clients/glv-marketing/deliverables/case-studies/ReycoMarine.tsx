import Layout from "@/components/Layout";
import SEOHead from "@/components/SEOHead";
import AnimatedSection from "@/components/AnimatedSection";
import Breadcrumbs from "@/components/Breadcrumbs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Globe,
  Search,
  Store,
  ShieldCheck,
  Layout as LayoutIcon,
  Target,
  Code,
  ExternalLink,
  CheckCircle,
  Package,
  MapPin,
} from "lucide-react";

// ─── DRAFT — Awaiting Aiden re-QC ────────────────────────────────────────────
// Revision 2 (2026-05-12): per Aiden direction via boss
//   - Stripped quote/testimonial section (no Casey quote on file)
//   - Stripped keywords table (GSC data months out — re-add when live)
//   - GBP confirmed set up by Aiden — included as deliverable
//   - Re-framed: WordPress/WooCommerce build case study (not SEO retainer)
//   - Removed all retainer/$/mo language
// ─────────────────────────────────────────────────────────────────────────────

const seo = {
  title: "Reyco Marine Case Study | GLV Marketing",
  description:
    "How GLV Marketing built Reyco Marine's production WordPress and WooCommerce site — structuring an 11-brand catalogue, running a pre-launch security audit, and executing a clean domain migration to reycomarine.com.",
  canonical: "https://glvmarketing.ca/case-studies/reyco-marine",
};

const tags = ["WordPress Development", "WooCommerce", "Security Audit", "Domain Migration", "Local SEO"];

const challenges = [
  {
    icon: Globe,
    title: "No Customer-Facing Website",
    desc: "Reyco operated through an internal staging subdomain. Customers had no online destination to browse inventory, book service, or research their 11 authorized brands.",
  },
  {
    icon: Search,
    title: "Zero Search Visibility",
    desc: "With no indexed production site, Reyco was invisible to buyers searching for marine service, Mercury dealers, or outdoor power equipment in Northern Ontario.",
  },
  {
    icon: Store,
    title: "Complex Product Catalogue",
    desc: "11 authorized brands across marine, lawn, snow, and ATV/UTV — plus seasonal services and parts — required a structured WooCommerce architecture, not a basic brochure site.",
  },
  {
    icon: ShieldCheck,
    title: "Security Before Scale",
    desc: "Launching a WooCommerce store without a pre-launch security review risked exposing the business to known vulnerabilities on day one.",
  },
];

const solutions = [
  {
    icon: LayoutIcon,
    title: "Custom WordPress + WooCommerce Build",
    desc: "Full production site built on WordPress with WooCommerce on SiteGround hosting. Canadian English throughout, mobile-responsive, structured around the full scope of Reyco's business: marine, lawn, snow, and ATV/UTV equipment, plus in-house service and an authorized parts department.",
  },
  {
    icon: Package,
    title: "11-Brand Catalogue Architecture",
    desc: "WooCommerce product catalogue structured around all 11 authorized brands — Echo, Princecraft, R&J, Toro, Mercury, EZGO, Cub Cadet, Minn Kota, Cannon, Humminbird, and Hisun — plus service categories covering marine, small engine, lawn, snow, and ATV/UTV. Each brand and category built for clean navigation and search indexing.",
  },
  {
    icon: ShieldCheck,
    title: "Pre-Launch Security Audit",
    desc: "Independent Tier 0 security review before public launch. All findings documented and remediated prior to cutover. Site cleared for production deployment — protecting the business and its customers from day one.",
  },
  {
    icon: Code,
    title: "Domain Migration",
    desc: "Clean cutover from the internal staging environment (reyco.glvmarketing.ca) to the production domain (reycomarine.com) on May 6, 2026. Redirect structure preserved any early crawl signal and eliminated split-authority issues at launch.",
  },
  {
    icon: Target,
    title: "On-Page SEO Configuration",
    desc: "Keyword research targeting Northern Ontario marine, small engine, and outdoor power searches. On-page optimisation across all product and service pages — brand, category, and location targeting. 356 product SEO assets deployed (196 meta descriptions + 160 alt-text entries). LocalBusiness schema deployed site-wide. Google Business Profile set up for Sault Ste. Marie.",
  },
  {
    icon: MapPin,
    title: "Google Business Profile",
    desc: "GBP set up and verified for Reyco Marine in Sault Ste. Marie — establishing local search presence at launch and supporting map pack eligibility for marine, small engine, and outdoor power searches in Northern Ontario.",
  },
];

const milestones = [
  {
    label: "Production site launched",
    value: "May 6, 2026",
    sub: "reycomarine.com — live on SiteGround",
    icon: CheckCircle,
  },
  {
    label: "Authorized brands structured",
    value: "11 brands",
    sub: "Full WooCommerce catalogue architecture",
    icon: Package,
  },
  {
    label: "Product SEO deployed",
    value: "356 assets",
    sub: "196 meta descriptions + 160 alt-text entries",
    icon: Search,
  },
  {
    label: "Pre-launch security",
    value: "Cleared",
    sub: "Tier 0 audit — all findings remediated",
    icon: ShieldCheck,
  },
  {
    label: "Domain migration",
    value: "Clean cutover",
    sub: "Staging → reycomarine.com, May 6",
    icon: Code,
  },
  {
    label: "Google Business Profile",
    value: "Active",
    sub: "Sault Ste. Marie — set up at launch",
    icon: MapPin,
  },
];

const ReycoMarine = () => (
  <Layout>
    <SEOHead title={seo.title} description={seo.description} canonical={seo.canonical} />

    {/* Hero */}
    <section className="section-padding">
      <div className="container max-w-4xl">
        <Breadcrumbs
          items={[
            { label: "Case Studies", href: "/case-studies" },
            { label: "Reyco Marine" },
          ]}
        />
        <AnimatedSection>
          <h1 className="text-4xl md:text-5xl font-heading font-bold mb-4">
            Reyco <span className="text-gradient">Marine</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mb-6">
            How GLV Marketing built Reyco Marine's production WordPress and WooCommerce site — structuring an 11-brand catalogue, running a pre-launch security audit, and executing a clean domain migration to launch Northern Ontario's premier marine and outdoor power dealer online.
          </p>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* Client Overview Bar */}
    <section className="border-y border-border bg-card">
      <div className="container max-w-4xl py-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {[
            { label: "Industry", value: "Marine & Outdoor Power" },
            { label: "Location", value: "Sault Ste. Marie, Ontario" },
            { label: "Website", value: "reycomarine.com", link: true },
            { label: "Engagement", value: "2026 – Present" },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{item.label}</p>
              {item.link ? (
                <a
                  href="https://reycomarine.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-semibold text-primary inline-flex items-center gap-1 hover:underline"
                >
                  {item.value} <ExternalLink size={12} />
                </a>
              ) : (
                <p className="text-sm font-semibold text-foreground">{item.value}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>

    {/* The Challenge */}
    <section className="section-padding">
      <div className="container max-w-4xl">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-4">The Challenge</h2>
          <p className="text-muted-foreground leading-relaxed max-w-3xl mb-8">
            Reyco Marine is a Sault Ste. Marie institution — a full-service dealer for marine, lawn, snow, and ATV/UTV equipment, with an in-house service team and an authorized parts department. Despite a strong local reputation, they had no customer-facing website and no presence in search:
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            {challenges.map((c) => (
              <div
                key={c.title}
                className="rounded-xl border border-border/50 bg-card p-5 flex gap-4"
              >
                <div className="w-10 h-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                  <c.icon className="text-primary" size={20} />
                </div>
                <div>
                  <h3 className="font-heading font-bold text-sm mb-1">{c.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{c.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* What We Did */}
    <section className="section-padding bg-card border-y border-border">
      <div className="container max-w-4xl">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-8">What We Built</h2>
          <div className="relative">
            <div className="absolute left-5 top-0 bottom-0 w-px bg-border hidden md:block" />
            <div className="space-y-8">
              {solutions.map((s, i) => (
                <div key={s.title} className="flex gap-5 relative">
                  <div className="w-10 h-10 shrink-0 rounded-full bg-primary/10 border-2 border-primary flex items-center justify-center z-10 relative">
                    <s.icon className="text-primary" size={18} />
                  </div>
                  <div className="pb-2">
                    <p className="text-[10px] uppercase tracking-wider text-primary/60 mb-1">Step {i + 1}</p>
                    <h3 className="font-heading font-bold mb-2">{s.title}</h3>
                    <p className="text-muted-foreground text-sm leading-relaxed">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* Results — Launch Milestones */}
    <section className="section-padding">
      <div className="container max-w-4xl">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-2 text-center">The Results</h2>
          <p className="text-muted-foreground text-center mb-10">
            Delivered at launch — May 6, 2026.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {milestones.map((m) => (
              <div key={m.label} className="rounded-xl border border-border/50 bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                    <m.icon className="text-primary" size={16} />
                  </div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium leading-tight">
                    {m.label}
                  </p>
                </div>
                <p className="text-foreground font-bold text-xl mb-1">{m.value}</p>
                <p className="text-muted-foreground text-xs">{m.sub}</p>
              </div>
            ))}
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* Key Takeaway */}
    <section className="section-padding bg-card border-y border-border">
      <div className="container max-w-3xl text-center">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-4">Key Takeaway</h2>
          <p className="text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            Reyco Marine had the inventory, the reputation, and the service team. What they needed was a digital foundation that matched all three. GLV Marketing delivered a production WordPress and WooCommerce site with a structured 11-brand catalogue, a clean security record, and a verified local search presence — all in place before the domain went live.
          </p>
        </AnimatedSection>
      </div>
    </section>

    {/* CTA */}
    <section className="section-padding">
      <div className="container max-w-2xl text-center">
        <AnimatedSection>
          <h2 className="text-3xl font-heading font-bold mb-4">Ready to build your business online?</h2>
          <p className="text-muted-foreground mb-8">
            Let's build a site that works as hard as you do, just like we did for Reyco Marine.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/contact">
              <Button variant="hero" size="xl">
                Book a Free Consultation <ArrowRight size={18} />
              </Button>
            </Link>
            <Link
              to="/case-studies"
              className="text-sm text-primary font-semibold hover:underline inline-flex items-center gap-1"
            >
              See More Case Studies <ArrowRight size={14} />
            </Link>
          </div>
        </AnimatedSection>
      </div>
    </section>
  </Layout>
);

export default ReycoMarine;
