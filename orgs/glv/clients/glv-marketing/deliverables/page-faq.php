<?php
/**
 * Template Name: GLV FAQ
 */
defined('ABSPATH') || exit;
get_header();
?>

<section class="section-padding">
    <div class="container max-w-3xl">
        <nav aria-label="Breadcrumb" class="mb-8">
            <ol class="flex items-center gap-2 text-sm text-muted-foreground">
                <li><a href="<?php echo esc_url(home_url('/')); ?>" class="hover:text-foreground transition-colors">Home</a></li>
                <li class="text-muted-foreground/40">›</li>
                <li class="text-foreground">FAQ</li>
            </ol>
        </nav>
        <div class="glv-animate-in">
            <h1 class="text-3xl sm:text-4xl md:text-5xl font-heading font-bold mb-4">
                Frequently Asked <span class="text-gradient">Questions</span>
            </h1>
            <p class="text-lg text-muted-foreground leading-relaxed">
                Get answers to common questions about our services, process, and how we help Northern Ontario businesses grow online.
            </p>
        </div>
    </div>
</section>

<section class="pb-16 md:pb-24">
    <div class="container max-w-3xl">

        <!-- Expand / Collapse All -->
        <div class="flex justify-end mb-6">
            <button id="glv-expand-all"
                    class="inline-flex items-center gap-2 text-xs font-medium text-primary border border-primary/30 rounded-md px-3 py-1.5 hover:bg-primary/10 transition-colors"
                    data-state="collapsed">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                Expand All
            </button>
        </div>

        <div class="space-y-12 md:space-y-16 glv-animate-in">

            <?php
            $faq_categories = [
                'About GLV Marketing' => [
                    ['q' => 'What is GLV Marketing?',
                     'a' => 'GLV Marketing is a digital marketing agency based in Sault Ste. Marie, Ontario. We help small and mid-sized businesses across Northern Ontario get found online and grow through local SEO, website design, paid advertising, AI automation, and Generative Engine Optimization (GEO).'],
                    ['q' => 'Who do you work with?',
                     'a' => 'We work primarily with local service businesses, trades, and professional firms in Northern Ontario. Our clients include home builders, financial services, and local service providers. If your business serves a local area and you want more customers finding you online, we\'re a good fit.'],
                    ['q' => 'What makes GLV different from other marketing agencies?',
                     'a' => 'We combine traditional digital marketing with AI-powered strategies like Generative Engine Optimization. We\'re local, so we understand the Northern Ontario market. We don\'t do cookie-cutter templates; every strategy is built for your specific business, market, and goals. And we focus on measurable results, not vanity metrics.'],
                    ['q' => 'Are you a one-person agency or a team?',
                     'a' => 'GLV Marketing is led by Aiden Glave, with support from strategic partners. We keep our team lean intentionally — it means you work directly with senior strategists, not junior account managers.'],
                ],
                'Our Services' => [
                    ['q' => 'What services do you offer?',
                     'a' => 'We offer Local SEO, GEO (AI Search), website design, paid advertising, content marketing, AI automation, and Google Business Profile optimization. Most clients start with a strategy engagement and build out services based on their goals.'],
                    ['q' => 'What is Generative Engine Optimization (GEO)?',
                     'a' => 'GEO is the practice of optimizing your business to appear in AI-generated search results. When someone asks ChatGPT, Google Gemini, or Perplexity "Who is the best [service] in Sault Ste. Marie?" we use structured data, entity building, and content optimization to make sure AI tools can find and recommend your business.'],
                    ['q' => 'Do you build websites?',
                     'a' => 'Yes. We build modern, fast, mobile-first websites designed to convert visitors into customers. Every website includes SEO-ready structure, SSL, and ongoing maintenance.'],
                    ['q' => 'Do you manage Google Ads and Facebook Ads?',
                     'a' => 'Yes. We manage both Google Ads and Meta Ads (Facebook and Instagram). We handle campaign strategy, audience targeting, ad creative, A/B testing, conversion tracking, and ongoing optimization. You get weekly performance monitoring and monthly reports with clear ROAS metrics.'],
                    ['q' => 'What is AI automation and how can it help my business?',
                     'a' => 'AI automation means using smart workflows to handle repetitive tasks like lead follow-up emails, report generation, appointment reminders, and CRM updates. We build custom automations that save you hours every week and make sure no lead falls through the cracks.'],
                ],
                'GEO &amp; AI Search' => [
                    ['q' => 'Why does AI search matter for my business?',
                     'a' => 'More people are using AI tools like ChatGPT and Google Gemini to find local businesses. When someone asks an AI "Who does the best bookkeeping in Sault Ste. Marie?" your business either shows up in the answer or it doesn\'t. GEO makes sure you\'re the one being recommended.'],
                    ['q' => 'How is GEO different from regular SEO?',
                     'a' => 'Traditional SEO focuses on ranking in Google\'s search results list. GEO focuses on getting cited in AI-generated answers. They complement each other: good SEO helps your GEO, and vice versa. We recommend both for maximum visibility.'],
                    ['q' => 'Can you guarantee my business will appear in AI answers?',
                     'a' => 'No one can guarantee AI citations because the algorithms are constantly evolving. What we can do is implement every known best practice: structured data, entity signals, authoritative content, and technical markup. This gives your business the strongest possible chance of being recommended by AI tools.'],
                    ['q' => 'Is GEO only for tech companies?',
                     'a' => 'Not at all. GEO is most valuable for local service businesses — the ones people ask AI about every day. Plumbers, accountants, builders, restaurants, dentists: if someone might ask an AI "Who is the best [your service] near me?" then GEO matters for you.'],
                ],
                'Pricing &amp; Process' => [
                    ['q' => 'How much do your services cost?',
                     'a' => 'Every engagement is scoped to your specific business and goals, so pricing varies. Book a free consultation and we will give you a clear, custom quote with no pressure and no obligation.'],
                    ['q' => 'Do you require long-term contracts?',
                     'a' => 'We work on month-to-month agreements after an initial 3-month onboarding period. The first 3 months are critical for building your foundation: SEO, website, profiles, and content all take time to gain traction. After that, you stay because the results speak for themselves.'],
                    ['q' => 'What does the onboarding process look like?',
                     'a' => 'We start with a free consultation to understand your business and goals. From there, we conduct a full audit of your current online presence, develop a custom strategy, and begin implementation. Most clients are fully onboarded within 2-3 weeks, with first results visible within 30-60 days.'],
                    ['q' => 'How do you report on results?',
                     'a' => 'Every client receives a monthly performance report covering search rankings, traffic, ad performance (if applicable), leads generated, and next steps. We use Google Search Console, Google Analytics, and Semrush for data. Reports are straightforward: no jargon, just clear metrics and what they mean for your business.'],
                ],
                'Working With Us' => [
                    ['q' => 'What area do you serve?',
                     'a' => 'We\'re based in Sault Ste. Marie, Ontario, and serve businesses across Northern Ontario including Sudbury, Timmins, Thunder Bay, North Bay, and surrounding communities. Since most of our work is digital, we can also work with clients anywhere in Ontario or across Canada.'],
                    ['q' => 'How do I get started?',
                     'a' => 'Book a free consultation through our contact page or call us at 705-975-0579. We\'ll discuss your business, your goals, and whether we\'re a good fit. No pressure, no obligation — just a straightforward conversation about how we can help you grow online.'],
                ],
            ];

            foreach ($faq_categories as $cat_title => $questions) :
            ?>
            <div>
                <!-- Category heading with red accent line -->
                <h2 class="text-2xl md:text-3xl font-heading font-bold mb-2"><?php echo $cat_title; ?></h2>
                <div class="mb-5">
                    <div class="h-0.5 w-12 bg-primary rounded-full mb-px"></div>
                    <div class="h-px bg-border/60"></div>
                </div>
                <!-- Accordion items -->
                <div class="space-y-3">
                    <?php foreach ($questions as $item) : ?>
                    <div class="glv-faq-item rounded-xl border border-border/50 bg-card overflow-hidden transition-colors duration-200 hover:border-primary/25">
                        <button class="glv-faq-trigger w-full text-left px-5 sm:px-6 py-5 font-heading font-medium text-foreground flex items-center justify-between gap-4 hover:bg-primary/[0.03] transition-colors duration-150"
                                aria-expanded="false">
                            <span class="text-sm sm:text-base leading-snug"><?php echo esc_html($item['q']); ?></span>
                            <svg class="glv-faq-chevron shrink-0 text-primary/60 transition-transform duration-200" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        <div class="glv-faq-content hidden px-5 sm:px-6 pb-6 pt-2 text-muted-foreground leading-relaxed text-sm border-t border-border/30">
                            <?php echo wp_kses_post($item['a']); ?>
                        </div>
                    </div>
                    <?php endforeach; ?>
                </div>
            </div>
            <?php endforeach; ?>

        </div><!-- end space-y-12 -->
    </div>
</section>

<!-- CTA -->
<section class="section-padding bg-card border-y border-border">
    <div class="container max-w-2xl text-center glv-animate-in">
        <h2 class="text-2xl md:text-3xl font-heading font-bold mb-4">Still Have Questions?</h2>
        <p class="text-muted-foreground mb-8">Book a free 30-minute call and we will answer everything. No pressure, no obligation.</p>
        <a href="<?php echo esc_url(home_url('/contact')); ?>"
           class="inline-flex items-center gap-2 rounded-md font-semibold px-6 py-3 text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
            Book a Free Consultation
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        </a>
    </div>
</section>

<script>
(function(){
    function setOpen(item, open) {
        var content = item.querySelector('.glv-faq-content');
        var chevron = item.querySelector('.glv-faq-chevron');
        var btn     = item.querySelector('.glv-faq-trigger');
        content.classList.toggle('hidden', !open);
        chevron.style.transform = open ? 'rotate(180deg)' : '';
        btn.setAttribute('aria-expanded', String(open));
    }

    // Individual toggle
    document.querySelectorAll('.glv-faq-trigger').forEach(function(btn){
        btn.addEventListener('click', function(){
            var item = btn.closest('.glv-faq-item');
            var open = btn.getAttribute('aria-expanded') === 'true';
            setOpen(item, !open);
        });
    });

    // Expand / Collapse All
    var expandBtn = document.getElementById('glv-expand-all');
    if (expandBtn) {
        expandBtn.addEventListener('click', function(){
            var expanding = expandBtn.getAttribute('data-state') === 'collapsed';
            document.querySelectorAll('.glv-faq-item').forEach(function(item){
                setOpen(item, expanding);
            });
            expandBtn.setAttribute('data-state', expanding ? 'expanded' : 'collapsed');
            expandBtn.querySelector('svg').style.transform = expanding ? 'rotate(180deg)' : '';
            expandBtn.innerHTML = expandBtn.innerHTML.replace(
                expanding ? 'Expand All' : 'Collapse All',
                expanding ? 'Collapse All' : 'Expand All'
            );
        });
    }
})();
</script>

<?php get_footer(); ?>
