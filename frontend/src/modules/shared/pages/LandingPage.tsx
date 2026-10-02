import { useState, type MouseEvent } from 'react';

import { triggerEmergencyDeactivatedNotice } from '@shared/components/EmergencyDeactivatedModal';
import './LandingPage.css';

const heroStats = [
  { value: '<3 min', label: 'Median Case Acknowledgement' },
  { value: '24 / 7', label: 'Emergency Coordination' },
  { value: '98.2%', label: 'Alert Delivery Reliability' },
];

const trustPartners = [
  'CityCare Network',
  'Metro EMS Alliance',
  'Ruby Hall Emergency',
  'Sudha Hospitals',
  'Critical Response Forum',
];

const operationalMetrics = [
  { value: '11 min', label: 'Average Door-to-Care Prep' },
  { value: '415+', label: 'Verified Family Reviews' },
  { value: '5.0/5.0', label: 'Care Experience Score' },
];

const workflowSteps = [
  {
    step: '01',
    title: 'Trigger Emergency on WhatsApp',
    description:
      'Patients or families send HELP with live location. CodeRed captures incident context and priority in seconds.',
  },
  {
    step: '02',
    title: 'Smart Ambulance and Hospital Matching',
    description:
      'The platform routes cases using severity, distance, traffic conditions, and current ER capacity signals.',
  },
  {
    step: '03',
    title: 'Pre-Arrival Clinical Handoff',
    description:
      'Drivers and emergency teams share one timeline so hospitals are prepared before patient arrival at triage.',
  },
];

const roleFeatureGroups = [
  {
    icon: '📱',
    role: 'Patients and Families',
    points: [
      'No app install required for urgent dispatch trigger',
      'Real-time ETA and destination updates on one thread',
      'Guided checklist to share key symptoms quickly',
    ],
  },
  {
    icon: '🚑',
    role: 'Ambulance Teams',
    points: [
      'Live route optimization with incident priority awareness',
      'Instant case updates while en route to the patient',
      'Structured handoff packet sent ahead to emergency unit',
    ],
  },
  {
    icon: '🏥',
    role: 'Hospital Emergency Units',
    points: [
      'Early case intake before arrival for room readiness',
      'Capacity-aware queue visibility across incoming incidents',
      'Clinical summary stream aligned with transport timeline',
    ],
  },
  {
    icon: '🖥️',
    role: 'Operations and Admins',
    points: [
      'Command center timeline for every active incident',
      'Audit-ready event logs for compliance and review',
      'Performance analytics to reduce avoidable delays',
    ],
  },
];

const aboutHighlights = [
  {
    title: 'Who We Are',
    description:
      'CodeRed is an emergency coordination platform built with healthcare partners, field responders, and hospital ops teams.',
  },
  {
    title: 'What We Solve',
    description:
      'We reduce dispatch friction, improve first-touch triage quality, and make handoffs faster between teams.',
  },
  {
    title: 'Why It Works',
    description:
      'Shared situational awareness keeps everyone aligned during high-pressure moments where minutes define outcomes.',
  },
];

const testimonials = [
  {
    quote:
      'Our emergency desk now receives cleaner case data before the ambulance arrives. That saves critical minutes every shift.',
    name: 'Dr. Rhea Kulkarni',
    role: 'Emergency Physician, Pune',
  },
  {
    quote:
      'Drivers get hospital readiness updates in transit, so we avoid confusion at handoff and move straight to treatment.',
    name: 'Karan Patil',
    role: 'Senior Ambulance Lead',
  },
  {
    quote:
      'The operations timeline gives us complete visibility for post-incident review without chasing scattered records.',
    name: 'Nivedita Shah',
    role: 'Hospital Operations Manager',
  },
];

const faqItems = [
  {
    question: 'Do patients need to install an app to request emergency support?',
    answer:
      'No. Patients can trigger emergency support instantly through WhatsApp with HELP and live location sharing.',
  },
  {
    question: 'How does CodeRed choose the destination hospital?',
    answer:
      'The routing engine evaluates distance, real-time ER capacity, and case severity to suggest the best fit hospital.',
  },
  {
    question: 'Can ambulance teams and hospitals track the same incident together?',
    answer:
      'Yes. Both portals stay synchronized in real time so all teams see consistent status, ETA, and clinical context.',
  },
  {
    question: 'Is incident history available for operational audits?',
    answer:
      'Yes. Every key action is timestamped and stored in an audit-ready history for compliance and process improvement.',
  },
];

const reviewAvatars = [
  'https://images.unsplash.com/photo-1544725176-7c40e5a71c5e?auto=format&fit=crop&w=72&q=80',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=72&q=80',
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=72&q=80',
  'https://images.unsplash.com/photo-1557862921-37829c790f19?auto=format&fit=crop&w=72&q=80',
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=72&q=80',
];

const galleryImages = {
  top: 'https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?auto=format&fit=crop&w=900&q=80',
  main: 'https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=1200&q=80',
  side: 'https://images.unsplash.com/photo-1584515933487-779824d29309?auto=format&fit=crop&w=900&q=80',
};

const heartbeatPath =
  'M24 64 H108 L124 64 L134 34 L146 92 L158 24 L170 64 H238 L258 64 L271 52 L286 76 L300 60 H352';

const heartPath =
  'M374 65 C374 54 387 51 394 60 C401 51 414 54 414 65 C414 76 402 84 394 93 C386 84 374 76 374 65 Z';

function WhatsAppIcon() {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
      <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.555 4.116 1.529 5.845L0 24l6.335-1.51A11.946 11.946 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.8 9.8 0 01-5.012-1.374l-.36-.213-3.76.896.957-3.665-.234-.376A9.818 9.818 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z" />
    </svg>
  );
}

export default function LandingPage() {
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

  const handleScrollToHowItWorks = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = document.getElementById('how-it-works');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <main className="landing-page">
      <section className="hero section-shell">
        <div className="hero-left reveal reveal-delay-1">
          <p className="eyebrow">Emergency Coordination Platform</p>
          <h1 className="hero-title">From HELP message to hospital handoff without delay.</h1>
          <p className="hero-sub">
            CodeRed connects patients, ambulance crews, and hospital emergency units in one live timeline so critical
            treatment starts faster.
          </p>

          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={triggerEmergencyDeactivatedNotice}
            >
              <WhatsAppIcon />
              Send Help Now
            </button>
            <a className="btn btn-secondary" href="#how-it-works" onClick={handleScrollToHowItWorks}>
              See How It Works
            </a>
          </div>

          <div className="hero-rating" aria-label="Patient review summary">
            <div className="avatar-stack">
              {reviewAvatars.map((avatar, index) => (
                <img key={avatar} src={avatar} alt="Patient review avatar" style={{ zIndex: 9 - index }} loading="lazy" />
              ))}
            </div>
            <span className="rating-stars">★★★★★</span>
            <span className="rating-copy">Trusted by 415+ families and care teams</span>
          </div>

          <div className="stat-grid" aria-label="Emergency response performance">
            {heroStats.map((stat) => (
              <article className="stat-card" key={stat.label}>
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
              </article>
            ))}
          </div>
        </div>

        <aside className="hero-right reveal reveal-delay-2" aria-label="Emergency operations visual preview">
          <div className="image-collage">
            <figure className="photo-card photo-top">
              <img src={galleryImages.top} alt="Emergency doctor portrait" loading="lazy" />
            </figure>
            <figure className="photo-card photo-main">
              <img src={galleryImages.main} alt="Emergency care team in critical unit" loading="lazy" />
            </figure>
            <figure className="photo-card photo-side">
              <img src={galleryImages.side} alt="Hospital accident and emergency department" loading="lazy" />
            </figure>

            <article className="media-chip chip-top" aria-label="Live operations metric">
              <p>Live Incidents</p>
              <strong>42 Active Cases</strong>
            </article>
            <article className="media-chip chip-bottom" aria-label="Care preparation metric">
              <p>ER Prep Time</p>
              <strong>11 min Avg</strong>
            </article>
          </div>

          <div className="heartbeat-strip" aria-hidden="true">
            <svg className="heartbeat-svg" viewBox="0 0 430 120" role="img">
              <path className="heartbeat-grid" d="M18 36 H412 M18 64 H412 M18 92 H412" />
              <path className="heartbeat-line" d={heartbeatPath} />
              <path className="heartbeat-heart" d={heartPath} />
            </svg>
          </div>
        </aside>
      </section>

      <section className="trust-band section-shell reveal reveal-delay-3" aria-label="Trusted partners and outcomes">
        <p className="trust-heading">Trusted by emergency networks, hospital operators, and ambulance partners.</p>
        <ul className="partner-list" aria-label="Healthcare and emergency partners">
          {trustPartners.map((partner) => (
            <li key={partner}>{partner}</li>
          ))}
        </ul>
        <div className="trust-metrics" aria-label="Operational outcomes">
          {operationalMetrics.map((metric) => (
            <article className="trust-metric-card" key={metric.label}>
              <strong>{metric.value}</strong>
              <span>{metric.label}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="section-block section-shell" id="how-it-works">
        <div className="section-head reveal">
          <p className="eyebrow">How It Works</p>
          <h2 className="section-title">Three coordinated steps to reduce response delay.</h2>
        </div>

        <div className="workflow-grid">
          {workflowSteps.map((step, index) => (
            <article className={`workflow-card reveal reveal-delay-${(index % 6) + 1}`} key={step.step}>
              <p className="workflow-step">{step.step}</p>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-block section-shell" id="features">
        <div className="section-head reveal">
          <p className="eyebrow">Role-Based Features</p>
          <h2 className="section-title">Each team sees exactly what they need, when they need it.</h2>
        </div>

        <div className="role-grid">
          {roleFeatureGroups.map((group, index) => (
            <article className={`role-card reveal reveal-delay-${(index % 6) + 1}`} key={group.role}>
              <div className="role-head">
                <span className="role-icon" aria-hidden="true">
                  {group.icon}
                </span>
                <h3>{group.role}</h3>
              </div>
              <ul>
                {group.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="section-block section-shell about-block" id="about">
        <div className="section-head reveal">
          <p className="eyebrow">About CodeRed</p>
          <h2 className="section-title">Emergency technology designed with real response teams.</h2>
        </div>

        <div className="about-grid">
          <article className="about-main-card reveal">
            <p className="about-main-label">Our Mission</p>
            <h3>Shorten emergency delays without compromising human-centered care.</h3>
            <p>
              We collaborate with hospitals, emergency physicians, and field teams to improve every stage from first
              signal to treatment handoff. CodeRed is built for clarity under pressure.
            </p>
          </article>

          <div className="about-highlight-list">
            {aboutHighlights.map((item, index) => (
              <article className={`about-highlight-item reveal reveal-delay-${(index % 6) + 1}`} key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section-block section-shell testimonial-block" id="reviews">
        <div className="section-head narrow reveal">
          <p className="eyebrow">Field Feedback</p>
          <h2 className="section-title">Teams report faster handoffs and clearer emergency decisions.</h2>
        </div>

        <div className="testimonial-grid">
          {testimonials.map((testimonial, index) => (
            <article className={`testimonial-card reveal reveal-delay-${(index % 6) + 1}`} key={testimonial.name}>
              <p className="testimonial-quote">"{testimonial.quote}"</p>
              <p className="testimonial-name">{testimonial.name}</p>
              <p className="testimonial-role">{testimonial.role}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-block section-shell faq-block" id="faq">
        <div className="section-head narrow reveal">
          <p className="eyebrow">Frequently Asked Questions</p>
          <h2 className="section-title">Answers for hospitals, responders, and families.</h2>
        </div>

        <div className="faq-list">
          {faqItems.map((item, index) => (
            <details
              className={`faq-item reveal reveal-delay-${(index % 6) + 1}`}
              key={item.question}
              open={openFaqIndex === index}
            >
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  setOpenFaqIndex((current) => (current === index ? null : index));
                }}
                aria-expanded={openFaqIndex === index}
              >
                <span>{item.question}</span>
                <span className="faq-toggle" aria-hidden="true">
                  <span className="faq-toggle-icon" />
                </span>
              </summary>
              <div className="faq-answer">
                <div className="faq-answer-inner">
                  <p>{item.answer}</p>
                </div>
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="cta-band section-shell reveal">
        <div>
          <p className="eyebrow">Emergency Ready</p>
          <h2>Give every patient a faster first response path.</h2>
        </div>
        <div className="cta-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={triggerEmergencyDeactivatedNotice}
          >
            <WhatsAppIcon />
            Send Help Now
          </button>
          <a className="btn btn-secondary" href="#how-it-works" onClick={handleScrollToHowItWorks}>
            See How It Works
          </a>
        </div>
      </section>

      <button
        type="button"
        className="mobile-emergency-cta"
        onClick={triggerEmergencyDeactivatedNotice}
        aria-label="Send Help Now"
      >
        <WhatsAppIcon />
        Send Help Now
      </button>
    </main>
  );
}
