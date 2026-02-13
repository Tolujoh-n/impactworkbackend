const nodemailer = require('nodemailer');

// Helper function to clean environment variable values (remove quotes, commas, whitespace)
const cleanEnvVar = (value, defaultValue = '') => {
  if (!value) return defaultValue;
  // Convert to string
  let cleaned = String(value);
  // Remove ALL single and double quotes from anywhere in the string
  cleaned = cleaned.replace(/['"]/g, '');
  // Remove trailing commas
  cleaned = cleaned.replace(/,+$/g, '');
  // Trim whitespace
  cleaned = cleaned.trim();
  return cleaned || defaultValue;
};

// Create reusable transporter object using SMTP transport
const createTransporter = () => {
  // Support both SMTP_* and EMAIL_* environment variable names, and clean them
  let host = cleanEnvVar(process.env.SMTP_HOST || process.env.EMAIL_HOST, 'smtp.gmail.com');
  // Extra safety: remove any remaining quotes (shouldn't be needed, but just in case)
  host = host.replace(/['"]/g, '').trim();
  
  const port = parseInt(cleanEnvVar(process.env.SMTP_PORT || process.env.EMAIL_PORT, '587'), 10);
  const secure = cleanEnvVar(process.env.SMTP_SECURE || process.env.EMAIL_SECURE, 'false') === 'true';
  const user = cleanEnvVar(process.env.SMTP_USER || process.env.EMAIL_USER);
  const pass = cleanEnvVar(process.env.SMTP_PASS || process.env.EMAIL_PASS);
  
  return nodemailer.createTransport({
    host: host,
    port: port,
    secure: secure, // true for 465, false for other ports
    auth: {
      user: user,
      pass: pass
    }
  });
};

/**
 * Send notification email to user
 * @param {Object} options - Email options
 * @param {String} options.to - Recipient email address
 * @param {String} options.subject - Email subject
 * @param {String} options.title - Notification title
 * @param {String} options.message - Notification message
 * @param {String} options.actionUrl - URL for action button
 * @param {String} options.actionText - Text for action button (default: "View Details")
 * @returns {Promise<Object>} Email send result
 */
const sendNotificationEmail = async ({ to, subject, title, message, actionUrl, actionText = 'View Details' }) => {
  try {
    // Validate required fields
    if (!to || !subject || !title || !message) {
      console.error('Email validation failed:', { to: !!to, subject: !!subject, title: !!title, message: !!message });
      throw new Error('Missing required email fields');
    }

    // Check if SMTP is configured (support both SMTP_* and EMAIL_* variable names, and clean them)
    let smtpUser = cleanEnvVar(process.env.SMTP_USER || process.env.EMAIL_USER);
    let smtpPass = cleanEnvVar(process.env.SMTP_PASS || process.env.EMAIL_PASS);
    let smtpHost = cleanEnvVar(process.env.SMTP_HOST || process.env.EMAIL_HOST, 'smtp.gmail.com');
    const smtpPort = cleanEnvVar(process.env.SMTP_PORT || process.env.EMAIL_PORT, '587');
    
    // Extra safety: ensure no quotes remain (shouldn't be needed, but just in case)
    smtpHost = smtpHost.replace(/['"]/g, '').trim();
    
    if (!smtpUser || !smtpPass) {
      console.error('SMTP not configured. Missing:', {
        SMTP_USER: !!smtpUser,
        SMTP_PASS: !!smtpPass,
        EMAIL_USER: !!process.env.EMAIL_USER,
        EMAIL_PASS: !!process.env.EMAIL_PASS,
        SMTP_HOST: smtpHost,
        SMTP_PORT: smtpPort,
        raw_SMTP_HOST: process.env.SMTP_HOST,
        raw_SMTP_USER: process.env.SMTP_USER ? process.env.SMTP_USER.substring(0, 10) + '...' : 'undefined'
      });
      return { success: false, error: 'SMTP not configured' };
    }

    console.log('Attempting to send email:', {
      to,
      subject,
      smtpHost,
      smtpPort,
      smtpUser: smtpUser.substring(0, 3) + '***' // Partially hide email for security
    });

    const transporter = createTransporter();
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    const fullActionUrl = actionUrl ? `${clientUrl}${actionUrl}` : clientUrl;

    // Professional HTML email template
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
          <tr>
            <td align="center" style="padding: 40px 20px;">
              <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <!-- Header -->
                <tr>
                  <td style="padding: 30px 30px 20px; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px 8px 0 0;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Workloob</h1>
                  </td>
                </tr>
                
                <!-- Content -->
                <tr>
                  <td style="padding: 40px 30px;">
                    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 20px; font-weight: 600;">${title}</h2>
                    <p style="margin: 0 0 30px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">${message}</p>
                    
                    ${actionUrl ? `
                    <!-- Action Button -->
                    <table role="presentation" style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td align="center" style="padding: 20px 0;">
                          <a href="${fullActionUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(102, 126, 234, 0.3);">${actionText}</a>
                        </td>
                      </tr>
                    </table>
                    ` : ''}
                  </td>
                </tr>
                
                <!-- Footer -->
                <tr>
                  <td style="padding: 30px; text-align: center; background-color: #f9f9f9; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e5e5;">
                    <p style="margin: 0 0 10px; color: #6b7280; font-size: 14px;">This is an automated notification from Workloob.</p>
                    <p style="margin: 0; color: #9ca3af; font-size: 12px;">You received this email because you have email notifications enabled in your account settings.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    // Plain text version
    const textContent = `
${title}

${message}

${actionUrl ? `${actionText}: ${fullActionUrl}` : ''}

---
This is an automated notification from Workloob.
You received this email because you have email notifications enabled in your account settings.
    `;

    const mailOptions = {
      from: `"Workloob" <${smtpUser}>`,
      to: to,
      subject: subject,
      text: textContent,
      html: htmlContent
    };

    // Verify connection before sending
    await transporter.verify();
    console.log('SMTP connection verified successfully');

    const info = await transporter.sendMail(mailOptions);
    console.log('Notification email sent successfully:', {
      messageId: info.messageId,
      to: info.accepted,
      rejected: info.rejected
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending notification email:', {
      error: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode,
      stack: error.stack
    });
    return { success: false, error: error.message, details: error.code || error.responseCode };
  }
};

/**
 * Send email notification based on notification object and user preferences
 * @param {Object} notification - Notification object from database
 * @param {Object} user - User object with notificationEmail and preferences
 * @param {String} clientUrl - Base URL for the client application
 * @returns {Promise<Object>} Email send result
 */
const sendEmailForNotification = async (notification, user, clientUrl = null) => {
  try {
    console.log('Checking email notification eligibility:', {
      userId: user?._id,
      notificationType: notification?.type,
      hasEmail: !!user?.notificationEmail,
      emailEnabled: user?.preferences?.notifications?.email,
      chatEnabled: user?.preferences?.notifications?.chat
    });
    
    // Check if user has email notifications enabled and has a notification email
    if (!user?.preferences?.notifications?.email || !user?.notificationEmail) {
      console.log('Email notification skipped:', {
        reason: !user?.preferences?.notifications?.email ? 'Email notifications disabled' : 'No notification email set',
        hasEmail: !!user?.notificationEmail,
        emailEnabled: user?.preferences?.notifications?.email
      });
      return { success: false, skipped: true, reason: 'Email notifications disabled or no notification email set' };
    }

    // For chat notifications, check if chat notifications are enabled
    if (notification.type === 'message' && !user?.preferences?.notifications?.chat) {
      console.log('Email notification skipped: Chat notifications disabled');
      return { success: false, skipped: true, reason: 'Chat notifications disabled' };
    }

    const baseUrl = clientUrl || process.env.CLIENT_URL || 'http://localhost:3000';
    let actionUrl = null;
    let actionText = 'View Details';

    // Determine action URL based on notification type and data
    if (notification.data?.chatId) {
      actionUrl = `/chats/${notification.data.chatId}`;
      actionText = 'View Message';
    } else if (notification.data?.jobId) {
      actionUrl = `/jobs/${notification.data.jobId}`;
      actionText = 'View Job';
    } else if (notification.data?.gigId) {
      actionUrl = `/gigs/${notification.data.gigId}`;
      actionText = 'View Gig';
    }

    return await sendNotificationEmail({
      to: user.notificationEmail,
      subject: notification.title,
      title: notification.title,
      message: notification.message,
      actionUrl: actionUrl,
      actionText: actionText
    });
  } catch (error) {
    console.error('Error in sendEmailForNotification:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendNotificationEmail,
  sendEmailForNotification
};
