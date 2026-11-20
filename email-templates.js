'use strict';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

const templateNames = {
  tracking_created: 'Order tracking',
  shipment_update: 'Shipment update',
  bank_order: 'Bank order notification',
  contact_received: 'Contact confirmation',
  registration_verification: 'Registration verification',
  password_reset: 'Password reset code',
  email_change_old: 'Verify current email',
  email_change_new: 'Verify new email'
};

function renderEmail(type, data) {
  let subject, eyebrow, title, paragraphs, detail, action, footer;
  switch (type) {
    case 'tracking_created':
    case 'shipment_update':
      subject = type === 'tracking_created' ? 'Your TurqueX tracking link' : 'TurqueX shipment update';
      eyebrow = 'Your order journey';
      title = type === 'tracking_created' ? 'Your order is received' : 'A shipment update';
      paragraphs = [type === 'tracking_created'
        ? 'Your order has been received. Shipment progress will appear after the dealership updates it.'
        : `A shipment update was recorded: ${data.stage} (${data.eventAt}). Check the link for the latest status.`];
      detail = `Tracking code: ${data.code}`;
      action = { label: 'Track your order', url: data.link };
      footer = 'Anyone with the code or link can view shipment progress. Keep it private.';
      break;
    case 'bank_order':
      subject = `New bank-transfer vehicle order ${data.orderId}`;
      eyebrow = 'Order notification';
      title = 'Bank transfer requested';
      paragraphs = [
        `Order: ${data.orderId}`,
        `Customer: ${data.name} (${data.email}, ${data.phone})`,
        `Address: ${data.address}`,
        `Vehicles:\n${data.items}`,
        `Total: $${Number(data.total).toFixed(2)} USD`,
        `Requested display currency: ${data.currency}`,
        'Assign a bank account in the dashboard to start the payment window.'
      ];
      break;
    case 'contact_received':
      subject = 'We received your message | TurqueX';
      eyebrow = 'We are here to help';
      title = 'Thank you for reaching out';
      paragraphs = [`Hello ${data.name},`, 'Your message has been received by our team. We will review your inquiry and get back to you as soon as we can.', `Inquiry: ${data.inquiry}`];
      footer = 'This is an acknowledgement, not a confirmation of a purchase or appointment.';
      break;
    case 'registration_verification':
      subject = 'Verify your TurqueX account';
      eyebrow = 'Welcome to TurqueX';
      title = 'Verify your email address';
      paragraphs = ['Enter the verification code below to finish creating your account. It expires in 10 minutes.'];
      detail = data.code;
      footer = 'If you did not create an account, you can ignore this email. Never share your code.';
      break;
    case 'password_reset':
      subject = 'Your TurqueX password reset code';
      eyebrow = 'Account security';
      title = 'Reset your password';
      paragraphs = ['Use the verification code below to reset your password. It expires in 10 minutes.'];
      detail = data.code;
      footer = 'If you did not request this, you can ignore this email. Never share your code.';
      break;
    case 'email_change_old':
    case 'email_change_new':
      subject = 'Your TurqueX email verification code';
      eyebrow = 'Account security';
      title = type === 'email_change_old' ? 'Verify your current email' : 'Verify your new email';
      paragraphs = [type === 'email_change_old'
        ? 'Use this code to verify your current email before changing your account email.'
        : 'Use this code to confirm your new email address. Your account will not change until you verify it.',
      'This code expires in 10 minutes.'];
      detail = data.code;
      footer = 'If you did not request this, secure your account and contact our team. Never share your code.';
      break;
    default:
      throw new Error('Unknown email template.');
  }
  const text = [title, ...paragraphs, detail, action ? `${action.label}: ${action.url}` : null, footer, 'TurqueX'].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#090a0d;color:#eef0f3;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#090a0d"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#15171c;border:1px solid #30323a;border-radius:16px">
<tr><td style="padding:28px 32px 18px;border-bottom:1px solid #30323a"><span style="font-size:23px;font-weight:800;letter-spacing:2px;color:#ffffff">TURQUE<span style="color:#e84050">X</span></span><span style="float:right;color:#9da4ae;font-size:11px;letter-spacing:1px;text-transform:uppercase">Driven by trust</span></td></tr>
<tr><td style="padding:36px 32px"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#ff7f8a;text-transform:uppercase">${escapeHtml(eyebrow)}</div>
<h1 style="font-size:28px;line-height:1.2;color:#ffffff;margin:14px 0 24px">${escapeHtml(title)}</h1>
${paragraphs.map(p => `<p style="font-size:15px;line-height:1.7;color:#d0d4db;margin:0 0 16px;white-space:pre-line">${escapeHtml(p)}</p>`).join('')}
${detail ? `<div style="background:#22242c;border:1px solid #3a3b45;border-radius:10px;padding:18px;margin:24px 0;color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:1px;overflow-wrap:anywhere">${escapeHtml(detail)}</div>` : ''}
${action ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:24px;background:#d83445"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:13px 24px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px">${escapeHtml(action.label)}</a></td></tr></table><p style="font-size:12px;line-height:1.5;color:#aab1ba;word-break:break-all;margin:16px 0 0">${escapeHtml(action.url)}</p>` : ''}
${footer ? `<p style="border-top:1px solid #30323a;padding-top:20px;margin:28px 0 0;font-size:12px;line-height:1.6;color:#aab1ba">${escapeHtml(footer)}</p>` : ''}</td></tr></table>
<p style="font-size:12px;color:#8f96a0;margin:20px 0 0">TurqueX &middot; Exceptional vehicles. Straightforward buying.</p></td></tr></table></body></html>`;
  return { subject, text, html };
}

function previewEmail(type) {
  return renderEmail(type, {
    stage: 'In transit', eventAt: '2026-01-15 10:30 UTC', code: type.startsWith('email_') || type === 'password_reset' || type === 'registration_verification' ? '123456' : 'TX-0123456789ABCDEF0123456789ABCDEF',
    link: 'https://cars.example.com/track#TX-0123456789ABCDEF0123456789ABCDEF',
    orderId: 'EXAMPLE-ORDER', name: 'Alex Morgan', email: 'alex@example.com', phone: '+1 555 0100',
    address: '1 Example Street, Austin, US', items: '- 2025 Example Vehicle x 1', total: 25000,
    currency: 'USD', inquiry: 'Vehicle inquiry'
  });
}

module.exports = { renderEmail, previewEmail, templateNames };
