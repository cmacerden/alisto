const { RequestError } = require('./request-error');

function duration(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function csvCell(value) {
  let text = value == null ? 'N/A' : String(value);
  // Quoting alone does not stop spreadsheet formula evaluation. Also protect
  // formulas preceded by whitespace/control characters, including tabs/newlines.
  if (/^[\s\u0000-\u0020]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

class ReportService {
  constructor(presence) { this.presence = presence; this.db = presence.db; }

  get(id, user) {
    const session = this.presence.authorize(id, user);
    if (session.status === 'live') throw new RequestError(409, 'End the session before opening its final report.');
    const snapshot = this.presence.snapshot(id, user);
    if (user.role === 'student') {
      snapshot.self.email = this.db.prepare('SELECT email FROM students WHERE id = ?').get(user.id).email;
    }
    return { ...snapshot, viewer: { id: user.id, role: user.role },
      completion_label: session.status === 'interrupted' ? 'Ended due to interruption' : 'Completed',
      measurement_label: session.source === 'meet' ? 'Browser-reported Google Meet call time' : 'Legacy Alisto connection time (not Meet call time)',
      notice: 'Final Offline status means the session is closed, not that the student left early. Rates describe detected presence and response frequency, not attention or academic performance. Unmeasured rates are N/A. Durations exclude the 60-second grace period; unverifiable time is disclosed separately since enrollment.' };
  }

  csv(report) {
    const headers = ['Session ID', 'Class', 'Session Date (UTC)', 'Completion', 'Saved Cutoff (UTC)', 'Measurement Source',
      'Name', 'Email', 'Final Status', 'Active Seconds', 'Total Measured Seconds', 'Cannot Verify Excluded Seconds',
      'Active Duration', 'Measured Duration', 'Cannot Verify Excluded Duration', 'Activity Rate',
      'Participated Count', 'Total Eligible Activities', 'Participation Rate', 'Classification', 'Report Notes'];
    const students = report.students || [report.self];
    const rows = students.map(student => [report.session.id, report.session.class_title,
      new Date(report.session.started_at).toISOString(), report.completion_label,
      new Date(report.session.ended_at).toISOString(), report.measurement_label,
      student.name, student.email, student.status, student.active_seconds, student.total_seconds,
      report.session.source === 'meet' ? student.excluded_seconds : null,
      duration(student.active_seconds), duration(student.total_seconds),
      report.session.source === 'meet' ? duration(student.excluded_seconds) : null,
      student.activity_rate == null ? null : `${student.activity_rate.toFixed(2)}%`,
      student.participation.responded_count, student.participation.eligible_count,
      student.participation.participation_rate == null ? null : `${student.participation.participation_rate.toFixed(2)}%`,
      student.participation.classification, report.notice]);
    return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  filename(report) {
    return `alisto-session-${report.session.id}-${report.viewer.role === 'teacher' ? 'class' : 'student-' + report.viewer.id}.csv`;
  }
}

module.exports = { ReportService, csvCell, duration };
