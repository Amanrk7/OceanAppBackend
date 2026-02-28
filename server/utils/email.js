const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Queue email for sending
async function queueEmail(to, subject, body) {
  try {
    await prisma.emailQueue.create({
      data: { to, subject, body }
    });
    console.log(`✉️ Email queued to ${to}: ${subject}`);
  } catch (err) {
    console.error('Failed to queue email:', err);
  }
}

// Send welcome email
async function sendWelcomeEmail(user) {
  const subject = 'Welcome to OceanBets!';
  const body = `
    Hi ${user.name},
    
    Welcome to OceanBets! We're excited to have you join our community.
    
    Your account details:
    Username: ${user.username}
    Referral Code: ${user.referralCode}
    
    Start playing and enjoy your welcome bonus!
    
    Best regards,
    The OceanBets Team
  `;
  
  await queueEmail(user.email, subject, body);
}

// Send transaction notification
async function sendTransactionEmail(user, transaction, approved) {
  const subject = approved 
    ? `Transaction Approved - ${transaction.type}` 
    : `Transaction Rejected - ${transaction.type}`;
  
  const body = approved 
    ? `Hi ${user.name},\n\nYour ${transaction.type} transaction of $${transaction.amount} has been approved.\n\nBest regards,\nThe OceanBets Team`
    : `Hi ${user.name},\n\nYour ${transaction.type} transaction of $${transaction.amount} has been rejected.\n\nReason: ${transaction.rejectedReason || 'Not specified'}\n\nBest regards,\nThe OceanBets Team`;
  
  await queueEmail(user.email, subject, body);
}

// Send password reset email
async function sendPasswordResetEmail(user, resetToken) {
  const subject = 'Password Reset Request';
  const body = `
    Hi ${user.name},
    
    We received a request to reset your password.
    
    Use this code to reset your password: ${resetToken}
    
    This code expires in 1 hour.
    
    If you didn't request this, please ignore this email.
    
    Best regards,
    The OceanBets Team
  `;
  
  await queueEmail(user.email, subject, body);
}

// Process email queue (to be run periodically)
async function processEmailQueue() {
  const pendingEmails = await prisma.emailQueue.findMany({
    where: { status: 'PENDING', attempts: { lt: 3 } },
    take: 10
  });

  for (const email of pendingEmails) {
    try {
      // Here you would integrate with actual email service (SendGrid, SES, etc.)
      // For now, we'll just log and mark as sent
      console.log(`📧 Sending email to ${email.to}: ${email.subject}`);
      
      await prisma.emailQueue.update({
        where: { id: email.id },
        data: { 
          status: 'SENT',
          sentAt: new Date()
        }
      });
    } catch (err) {
      await prisma.emailQueue.update({
        where: { id: email.id },
        data: { 
          attempts: { increment: 1 },
          error: err.message
        }
      });
    }
  }
}

module.exports = {
  queueEmail,
  sendWelcomeEmail,
  sendTransactionEmail,
  sendPasswordResetEmail,
  processEmailQueue
};