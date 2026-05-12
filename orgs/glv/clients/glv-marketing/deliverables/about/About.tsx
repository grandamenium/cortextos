import Layout from "@/components/Layout";
import SEOHead from "@/components/SEOHead";
import AnimatedSection from "@/components/AnimatedSection";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Target,
  Shield,
  Wrench,
  MapPin,
  Globe,
  CheckCircle,
  Briefcase,
  Sparkles,
} from "lucide-react";

// DRAFT v2 - awaiting Aiden QC
// Changes from v1 (a18f9793):
//   Story arc: 6-year internship credential replaces "watched agencies underdeliver" framing
//   Differentiators reordered: Customized lead + AI card softened (no vendor names)
//   Dropped Northern Ontario differentiator card (privacy card is stronger; NO covered in story + serves section)
//   SMB card broadened: "any business, SMBs are core"
//   2 tricolons stripped (hero + CTA)
//   Photo: /assets/aiden-glave.jpg (confirmed by dev, onError fallback removed)

const seo = {
  title: "About | GLV Marketing",
  description:
    "GLV Marketing is a Canadian marketing agency founded by Aiden Glave in Sault Ste. Marie, Ontario. Built for businesses that want real results, customized strategy, and direct access to the person doing the work.",
  canonical: "https://glvmarketing.ca/about",
};

const differentiators = [
  {
    icon: Sparkles,
    title: "Customized for Your Business, Not Templated",
    desc: "Every client gets a strategy built for their business specifically. GLV does not apply a standard package and call it done. The work is scoped around what your business actually needs, delivered to an industry-standard quality, and done efficiently enough that you are not waiting months for results.",
  },
  {
    icon: Target,
    title: "You Work With the Strategist",
    desc: "When you hire GLV, you work directly with me. Not a junior account manager who hands your account to someone else after the first call. Every strategy, every decision, every deliverable comes from the same person who understood your business from the start.",
  },
  {
    icon: Wrench,
    title: "Modern Tools and Systems",
    desc: "GLV uses current tools and automated workflows to do in hours what traditional agencies bill days for. That efficiency goes back into the quality and depth of the work, not into agency overhead. You get more done, faster, without paying for a team you never interact with.",
  },
  {
    icon: Shield,
    title: "Canadian Privacy Law, by Default",
    desc: "Most marketing agencies are not thinking about PIPEDA or PHIPA when they set up your tools. GLV is. If you operate in a regulated industry, your marketing infrastructure has to be compliant by design, not patched together after the fact.",
  },
];

const serves = [
  {
    icon: Briefcase,
    title: "Businesses of Any Size",
    desc: "GLV works with businesses of any size. Small and mid-sized businesses are the core because that is where direct-strategist access and customized work matter most. At that scale, templated agency work does real damage. At larger scales, GLV can scope accordingly.",
  },
  {
    icon: Shield,
    title: "Regulated Industries",
    desc: "Law firms, medical clinics, and financial advisors operate under compliance rules that generic marketing agencies ignore. GLV builds marketing systems for regulated businesses that work within those constraints, not around them.",
  },
  {
    icon: Globe,
    title: "Businesses That Want to Own Their Search Presence",
    desc: "Whether you are a local dealer in Northern Ontario or a professional services firm growing across Canada, GLV builds the organic foundation that makes customers find you without paying for every single click.",
  },
];

const About = () => (
  <Layout>
    <SEOHead title={seo.title} description={seo.description} canonical={seo.canonical} />

    {/* Hero */}
    <section className="section-padding">
      <div className="container max-w-5xl">
        <AnimatedSection>
          <div className="grid md:grid-cols-2 gap-10 items-center">
            <div>
              <p className="text-sm uppercase tracking-widest text-primary/70 font-medium mb-4">About</p>
              <h1 className="text-4xl md:text-5xl font-heading font-bold mb-6 leading-tight">
                I'm Aiden Glave. <br />
                I founded <span className="text-gradient">GLV Marketing</span>.
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed">
                After six years working inside a digital marketing firm, I came back to Sault Ste. Marie to build something better. A marketing agency that delivers the quality of work large firms produce, without the overhead, the account manager shuffle, or the templated thinking that comes with it.
              </p>
            </div>
            <div className="flex justify-center md:justify-end">
              <div className="rounded-2xl overflow-hidden border border-border/50 shadow-lg w-72 h-80 bg-muted flex items-center justify-center">
                <img
                  src="/assets/aiden-glave.jpg"
                  alt="Aiden Glave, founder of GLV Marketing"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* The Story */}
    <section className="section-padding bg-card border-y border-border">
      <div className="container max-w-3xl">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-6">How GLV Started</h2>
          <div className="space-y-5 text-muted-foreground leading-relaxed">
            <p>
              GLV Marketing is a digital marketing agency based in Sault Ste. Marie, Ontario, serving businesses across Northern Ontario and the rest of Canada. The agency started after six years working inside a digital marketing firm, long enough to see what good strategy requires when it is executed well, and what separates results that hold up over time from work that just looks busy.
            </p>
            <p>
              Most local businesses in Northern Ontario get one of two options when they hire help: cookie-cutter packages from a national chain agency that treats them as a small account, or a freelancer who specialises in a single channel and outsources the rest. Neither produces the integrated strategy (SEO, paid advertising, content, AI-powered automation, web development) that actually moves a small or mid-sized business forward.
            </p>
            <p>
              What changed is that the technology available now lets a single experienced operator deliver the depth of work that used to require a full agency team. Strategy, technical execution, content systems, performance reporting, all of it at industry-standard quality, without the overhead of coordinating across departments, account managers, and middlemen. The model works because the work itself is no less rigorous than it was inside a large firm.
            </p>
            <p>
              GLV is the result. Founder-run, based in Northern Ontario, building marketing systems for businesses anywhere in Canada. Customised to the business, not the package.
            </p>
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* Why Work With GLV */}
    <section className="section-padding">
      <div className="container max-w-4xl">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-3">Why Clients Choose GLV</h2>
          <p className="text-muted-foreground mb-8 max-w-2xl">
            GLV is a founder-run operation. Here is what that means in practice:
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            {differentiators.map((d) => (
              <div
                key={d.title}
                className="rounded-xl border border-border/50 bg-card p-6 flex gap-4"
              >
                <div className="w-10 h-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                  <d.icon className="text-primary" size={20} />
                </div>
                <div>
                  <h3 className="font-heading font-bold text-sm mb-2">{d.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{d.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* Who GLV Serves */}
    <section className="section-padding bg-card border-y border-border">
      <div className="container max-w-4xl">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-3">Who GLV Works With</h2>
          <p className="text-muted-foreground mb-8 max-w-2xl">
            GLV works with businesses across Canada at various stages of growth. The work is scoped to fit the business:
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            {serves.map((s) => (
              <div
                key={s.title}
                className="rounded-xl border border-border/50 bg-background p-5 flex flex-col gap-3"
              >
                <div className="w-10 h-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                  <s.icon className="text-primary" size={20} />
                </div>
                <h3 className="font-heading font-bold text-sm">{s.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* What GLV Delivers */}
    <section className="section-padding">
      <div className="container max-w-3xl">
        <AnimatedSection>
          <h2 className="text-2xl md:text-3xl font-heading font-bold mb-6">What GLV Actually Does</h2>
          <div className="space-y-4">
            {[
              "WordPress and WooCommerce builds: production-ready sites, not templates",
              "SEO and local search, built into the site from day one, not added later",
              "Email marketing: campaign strategy, automation, and list management",
              "Social media content strategy and planning",
              "Google Business Profile management and local search optimisation",
              "Marketing automation and content workflows using current tools",
              "GEO (Generative Engine Optimisation): positioning your business in AI-driven search results",
              "Google and Meta advertising for businesses that want measurable results",
              "Custom AI tools and automations for regulated industries (PIPEDA and PHIPA compliant by default)",
              "Reputation and review management: generation, monitoring, and response workflows",
              "Analytics and performance reporting: GA4 and Search Console dashboards",
              "Ongoing site management for clients who want a long-term partner, not a one-off build",
            ].map((item) => (
              <div key={item} className="flex items-start gap-3">
                <CheckCircle className="text-primary shrink-0 mt-0.5" size={18} />
                <p className="text-muted-foreground text-sm leading-relaxed">{item}</p>
              </div>
            ))}
          </div>
        </AnimatedSection>
      </div>
    </section>

    {/* CTA */}
    <section className="section-padding bg-card border-y border-border">
      <div className="container max-w-2xl text-center">
        <AnimatedSection>
          <h2 className="text-3xl font-heading font-bold mb-4">Let's talk about your business</h2>
          <p className="text-muted-foreground mb-8">
            Book a free 15-minute call. I'll ask a few questions about your business and tell you honestly whether GLV is the right fit.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/contact">
              <Button variant="hero" size="xl">
                Book a Free 15-Minute Call <ArrowRight size={18} />
              </Button>
            </Link>
            <Link
              to="/case-studies"
              className="text-sm text-primary font-semibold hover:underline inline-flex items-center gap-1"
            >
              See Our Work <ArrowRight size={14} />
            </Link>
          </div>
        </AnimatedSection>
      </div>
    </section>
  </Layout>
);

export default About;
