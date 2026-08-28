/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'

export function ReviewPage(): string {
  return Layout({
    title: 'Mission Control — Review',
    page: 'app',
    tab: 'review',
    islands: ['nav', 'dispatch'],
    meta: 'REVIEW · finished jobs with a diff · newest first',
    children: (
      <>
        <div class="phead">
          REVIEW QUEUE
          <span class="fixture" data-src="jobs">
            FIXTURE
          </span>
        </div>
        <div class="scroll">
          <table class="grid">
            <thead>
              <tr>
                <th>LABEL</th>
                <th>ENGINE</th>
                <th>CWD</th>
                <th>DIFF STAT</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="review-body">
              <tr class="empty">
                <td colspan="5">NOTHING WAITING ON REVIEW</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="foot">
          <div>
            <span class="msg" id="review-msg"></span>
          </div>
          <div safe>{'COPY REVIEW CMD · cd <cwd> && claude --continue'}</div>
        </div>
      </>
    ),
  })
}
