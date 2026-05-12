import Layout from "@/components/Layout";
import SEOHead from "@/components/SEOHead";
import AnimatedSection from "@/components/AnimatedSection";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Target,
  Shield,
  Zap,
  MapPin,
  Globe,
  CheckCircle,
  Briefcase,
} from "lucide-react";

// DRAFT - awaiting Aiden QC
// Flags for Aiden to unlock the best version:
//   [Q1] Story arc: confirm the "years watching agencies underdeliver" framing reflects your actual background
//   [Q2] Differentiation: confirm AI-powered tools claim is the primary differentiator you want to lead with
//   [Q3] Vertical fit: confirm law/medical/financial are the regulated verticals you want named on the about page
//   [Q4] External signal: any credential, publication, or client result you want cited here (or keep soft)
//   [Q5] Visual: founder photo available for hero section? (placeholder text works fine without one)

const seo = {
  title: "About | GLV Marketing",
  description:
    "GLV Marketing is a Canadian marketing agency founded by Aiden Glave in Sault Ste. Marie, Ontario. Built for small and mid-sized businesses that want real results without big-city agency overhead.",
  canonical: "https://glvmarketing.ca/about",
};

const differentiators = [
  {
    icon: Target,
    title: "You Work With the Strategist",
    desc: "When you hire GLV, you work directly with me. Not a junior account manager who hands your account to someone else after the first call. Every strategy, every decision, every deliverable comes from the same person who understood your business from the start.",
  },
  {
    icon: Zap,
    title: "AI Tools Built In-House",
    desc: "GLV builds and runs AI-powered marketing tools that most agencies are still treating as a buzzword. Automated workflows, content systems, and reporting pipelines that replace hours of manual work and let me focus on what actually moves the needle for your business.",
  },
  {
    icon: Shield,
    title: "Canadian Privacy Law, by Default",
    desc: "Most marketing agencies are not thinking about PIPEDA or PHIPA when they set up your tools. GLV is. If you operate in a regulated industry, your marketing infrastructure has to be compliant by design, not patched together after the fact.",
  },
  {
    icon: MapPin,
    title: "Northern Ontario, National Reach",
    desc: "GLV is based in Sault Ste. Marie. I understand the Northern Ontario market in a way that no Toronto or Vancouver agency does. And I bring the same quality of strategy to clients anywhere in Canada, because good marketing does not have a geography.",
  },
];

const serves = [
  {
    icon: Briefcase,
    title: "Small and Mid-Sized Canadian Businesses",
    desc: "Owners who want to grow online but are not ready to hand their marketing to a large agency and get lost in the shuffle. GLV is built for businesses where the owner still cares deeply about where their money goes.",
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
      <div className="container max-w-4xl">
        <AnimatedSection>
          <p className="text-sm uppercase tracking-widest text-primary/70 font-medium mb-4">About</p>
          <h1 className="text-4xl md:text-5xl font-heading font-bold mb-6 leading-tight">
            I'm Aiden Glave. <br />
            I built <span className="text-gradient">GLV Marketing</span> because small businesses deserve better.
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
            For years I watched agencies charge small business owners serious money for work that produced nothing. Cookie-cutter strategies. Junior staff. Reports that looked busy and moved nothing. I built GLV to fix that, starting in Northern Ontario, growing across Canada.
          </p>
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
              I started learning marketing on my own. Not through an agency, not through a program. I applied it to real businesses and started seeing what actually worked versus what agencies were selling. The gap was significant.
            </p>
            <p>
              Most agencies are built around account volume. They take on as many clients as possible, assign junior staff, and deliver templated work that looks professional but does not produce results. Small business owners pay for it anyway because they do not know what good looks like.
            </p>
            <p>
              I started GLV to close that gap. To give Canadian small businesses access to the same quality of strategy and tools that enterprise companies get, without the overhead, the account manager shuffle, or the agency markup on work that could be done better and faster with the right systems.
            </p>
            <p>
              GLV is based in Sault Ste. Marie. I understand what it takes to build a business in Northern Ontario, where the market is smaller, the margin for error is tighter, and every dollar of marketing spend has to count. That perspective shapes how I work with every client, regardless of where they are in Canada.
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
            GLV is not a team. It is a founder-run operation, and that is intentional. Here is what that means for you:
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
            GLV works best with a specific kind of business owner. If any of these sound like you, we should talk:
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
              "AI-powered marketing automation and content workflows",
              "GEO (Generative Engine Optimisation): positioning your business in AI-driven search results",
              "Google and Meta advertising for businesses that want measurable results",
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
            A 15-minute call is enough to figure out whether GLV is the right fit. No pitch deck. No pressure. Just a conversation about where you are and where you want to go.
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
