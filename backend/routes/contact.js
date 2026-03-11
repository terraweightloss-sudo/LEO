const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');

// ── Lazy-load nodemailer ─────────────────────────────────
let transporter;
function getMailer() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST  || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

// POST /api/contact
router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    // Validate
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (message.length < 10) {
      return res.status(400).json({ error: 'Message is too short (min 10 characters)' });
    }

    const safeSubject = subject || 'General Question';
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    // ── Store in DB for admin visibility ─────────────────
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, user_id, user_email, user_role, action, entity_type, entity_id, field_changed, old_value, new_value)
      VALUES (?, NULL, ?, 'customer', 'CONTACT_FORM_SUBMITTED', 'contact', ?, ?, ?, ?)
    `).run(uuidv4(), email, uuidv4(), safeSubject, name, message.substring(0, 500));

    // ── Send email if SMTP is configured ─────────────────
    const mailer = getMailer();
    if (mailer) {
      const toAddress = process.env.CONTACT_TO_EMAIL || process.env.SMTP_USER;

      // Email TO the business (Leo's team receives this)
      await mailer.sendMail({
        from: `"Leo's Auctions Contact Form" <${process.env.SMTP_USER}>`,
        to: toAddress,
        replyTo: `"${name}" <${email}>`,
        subject: `[Contact Form] ${safeSubject} — from ${name}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1B4D2E;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="color:#D4A017;margin:0;font-size:20px;letter-spacing:2px">LEO'S AUCTIONS</h2>
              <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:12px">New Contact Form Submission</p>
            </div>
            <div style="background:#fff;border:1px solid #E8E0CC;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:8px 0;color:#6B6B6B;width:110px">From</td><td style="padding:8px 0;font-weight:700">${name}</td></tr>
                <tr><td style="padding:8px 0;color:#6B6B6B">Email</td><td style="padding:8px 0"><a href="mailto:${email}" style="color:#1B4D2E">${email}</a></td></tr>
                <tr><td style="padding:8px 0;color:#6B6B6B">Subject</td><td style="padding:8px 0">${safeSubject}</td></tr>
                <tr><td style="padding:8px 0;color:#6B6B6B">Received</td><td style="padding:8px 0">${timestamp} ET</td></tr>
              </table>
              <div style="margin-top:20px;padding:16px;background:#FDF8F0;border-left:4px solid #D4A017;border-radius:0 6px 6px 0">
                <p style="margin:0;font-size:13px;color:#6B6B6B;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;font-weight:700">Message</p>
                <p style="margin:0;font-size:15px;line-height:1.7;color:#1A1A1A">${message.replace(/\n/g, '<br/>')}</p>
              </div>
              <div style="margin-top:20px;padding-top:20px;border-top:1px solid #E8E0CC">
                <a href="mailto:${email}?subject=Re: ${encodeURIComponent(safeSubject)}" style="display:inline-block;background:#D4A017;color:#000;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:700;font-size:13px">Reply to ${name} →</a>
              </div>
            </div>
          </div>
        `,
      });

      // Auto-reply TO the customer
      await mailer.sendMail({
        from: `"Leo's Auctions" <${process.env.SMTP_USER}>`,
        to: `"${name}" <${email}>`,
        subject: `We got your message! — Leo's Auctions`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1B4D2E;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="color:#D4A017;margin:0;font-size:20px;letter-spacing:2px">LEO'S AUCTIONS</h2>
              <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:12px">Tampa Bay's #1 Amazon Return Auction</p>
            </div>
            <div style="background:#fff;border:1px solid #E8E0CC;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="font-size:16px;margin:0 0 12px">Hey <strong>${name}</strong>! 👋</p>
              <p style="color:#444;line-height:1.7;margin:0 0 16px">Thanks for reaching out — we received your message about <strong>"${safeSubject}"</strong> and we'll get back to you within <strong>24 hours</strong>.</p>
              <div style="background:#FDF8F0;border-left:4px solid #D4A017;padding:14px 16px;border-radius:0 6px 6px 0;margin-bottom:20px">
                <p style="margin:0;font-size:13px;color:#6B6B6B">Your message:</p>
                <p style="margin:6px 0 0;font-size:14px;color:#444;line-height:1.6">${message.replace(/\n/g, '<br/>')}</p>
              </div>
              <p style="color:#444;line-height:1.7;margin:0 0 20px">In the meantime, check out our <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="color:#1B4D2E;font-weight:700">live auctions</a> — new inventory drops daily!</p>
              <div style="padding-top:20px;border-top:1px solid #E8E0CC;font-size:12px;color:#999">
                📍 Tampa Warehouse, Tampa Bay FL &nbsp;·&nbsp; Pickups: Saturdays 9AM–4PM
              </div>
            </div>
          </div>
        `,
      });

      console.log(`📧 Contact form email sent: ${name} <${email}> — ${safeSubject}`);
    } else {
      // No SMTP configured — log to console so owner can still see it
      console.log(`\n📬 CONTACT FORM (no SMTP configured — add SMTP keys to .env to receive emails)`);
      console.log(`   From:    ${name} <${email}>`);
      console.log(`   Subject: ${safeSubject}`);
      console.log(`   Message: ${message}`);
      console.log(`   Time:    ${timestamp}\n`);
    }

    res.json({
      success: true,
      message: mailer
        ? "Message sent! We'll reply within 24 hours."
        : "Message received! We'll get back to you soon.",
    });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again or email us directly.' });
  }
});

module.exports = router;
