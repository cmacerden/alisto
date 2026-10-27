const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = require('docx');
const { RequestError } = require('./request-error');
const { duration } = require('./reports');

const DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// XML 1.0 cannot represent control characters or unpaired surrogates. All
// remaining user text is escaped by docx, never interpreted as markup/fields.
function text(value) {
  return String(value ?? 'N/A').replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '');
}

async function reportDocument(report) {
  if (report.viewer?.role !== 'student' || !report.self || report.self.student_id !== report.viewer.id || report.students || report.session.status === 'live') {
    throw new RequestError(403, 'Only your own saved student report can be downloaded as a document.');
  }
  const student = report.self;
  const percent = value => value == null ? 'N/A' : `${value.toFixed(2)}%`;
  const heading = label => new Paragraph({ text: label, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } });
  const table = rows => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([label, value]) => new TableRow({ cantSplit: true, children: [
      new TableCell({ width: { size: 40, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })] }),
      new TableCell({ width: { size: 60, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: text(value) })] })
    ] }))
  });
  const document = new Document({ creator: 'Alisto', title: 'Personal session report', description: 'Saved student presence and participation summary',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 100 } } } } },
    sections: [{ children: [
      new Paragraph({ text: 'Alisto — Session Report', heading: HeadingLevel.TITLE }),
      new Paragraph({ text: 'Personal student record · saved results', spacing: { after: 200 } }),
      heading('Session'), table([
        ['Class', report.session.class_title], ['Session ID', report.session.id],
        ['Session date (UTC)', new Date(report.session.started_at).toISOString()],
        ['Completion', report.completion_label], ['Saved cutoff (UTC)', new Date(report.session.ended_at).toISOString()],
        ['Measurement source', report.measurement_label],
        ...(report.session.source === 'meet' ? [['Google Meet code', report.session.meet_code]] : [])
      ]),
      heading('Student'), table([['Name', student.name], ['Registered email', student.email], ['Final status', student.status]]),
      heading('Presence'), table([
        [report.session.source === 'meet' ? 'In call after grace' : 'Connected after grace', duration(student.active_seconds)],
        ['Verified measured time after grace', duration(student.total_seconds)],
        ['Cannot verify — excluded since enrollment', report.session.source === 'meet' ? duration(student.excluded_seconds) : 'N/A (legacy connection measurement)'],
        ['Activity Rate', percent(student.activity_rate)]
      ]),
      heading('Participation'), table([
        ['Responded prompts', student.participation.responded_count], ['Eligible prompts', student.participation.eligible_count],
        ['Participation Rate', percent(student.participation.participation_rate)], ['Classification', student.participation.classification]
      ]),
      heading('Report notes'), new Paragraph({ text: text(report.notice) }),
      new Paragraph({ text: 'Durations use H:MM:SS. Activity Rate = active time / verified measured time after grace. Participation Rate = responded prompts / eligible prompts. No chat messages, prompt text, or responses are included.' })
    ] }]
  });
  return Packer.toBuffer(document);
}

module.exports = { reportDocument, DOCUMENT_TYPE };
