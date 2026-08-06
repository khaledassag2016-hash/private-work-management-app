Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:Repo='khaledassag2016-hash/private-work-management-app'
$script:Branch='stage-3/identity-database-audit'

function Assert-S3RepositoryValidationOutput {
 param([Parameter(Mandatory)][string]$Text)
 $required=@(
  'RECONSTRUCTION: PASS',
  'FOUNDATION VALIDATION: PASS',
  'Coverage: FR 30/30, AC 14/14, P 7/7, scenarios 14/14',
  'S2 LOCAL VALIDATION: PASS'
 )
 foreach($needle in $required){
  if($Text -notmatch [regex]::Escape($needle)){throw "بوابة المستودع فشلت: $needle"}
 }
 if($Text -notmatch '(?m)Ran\s+11\s+tests' -or $Text -notmatch '(?m)(?:^|\s)tests\s+12(?:\s|$)'){
  throw 'تعذر إثبات اختبارات S2 البالغ عددها 23/23.'
 }
 if($Text -notmatch '63710' -or $Text -notmatch '6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b'){
  throw 'مرجع Word غير مطابق.'
 }
}

function Invoke-S3RepositoryGate {
 param([Parameter(Mandatory)]$Context)
 if($Context.Mode -eq 'Simulation'){
  $result=[ordered]@{
   repository=$script:Repo;commit='f4951b9bc28bcf6547294174377d10b1fc7a6439';reconstruction='PASS';size=63710
   sha256='6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b';foundation='PASS'
   fr='30/30';ac='14/14';p='7/7';scenarios='14/14';s2='PASS';s2Tests='23/23'
  }
  $result|ConvertTo-Json|Set-Content (Join-Path $Context.Root 'reports\02-repository-gate.json') -Encoding UTF8
  return $result
 }
 $repoPath=Join-Path $Context.Root 'repository'
 $auth=Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('auth','status') -AllowFailure
 if($auth.ExitCode -ne 0){
  Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('auth','login','--hostname','github.com','--web','--git-protocol','https') -TimeoutSeconds 600|Out-Null
 }
 if(-not(Test-Path (Join-Path $repoPath '.git'))){
  Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('repo','clone',$script:Repo,$repoPath,'--','--branch','main','--single-branch') -TimeoutSeconds 600|Out-Null
 }
 Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('fetch','origin','main','--prune')|Out-Null
 Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('switch','main')|Out-Null
 Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('reset','--hard','origin/main')|Out-Null
 $status=(Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('status','--porcelain')).StdOut.Trim()
 if($status){throw 'Git working tree غير نظيفة.'}
 $commit=(Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('rev-parse','HEAD')).StdOut.Trim()
 $requiredFiles=@('PROJECT_STATE.md','PROJECT_SUPERVISION_BRIEF.md','docs/DECISION_LOG.md','docs/ROADMAP.md','docs/architecture/ADR-001-FREE-ARCHITECTURE.md')
 foreach($file in $requiredFiles){if(-not (Test-Path (Join-Path $repoPath $file))){throw "ملف حاكم مفقود: $file"}}
 $issue=Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('issue','view','2','--repo',$script:Repo,'--json','number,state,title,body')
 $issueJson=$issue.StdOut|ConvertFrom-Json
 if($issueJson.state -ne 'OPEN'){throw 'Issue #2 ليست مفتوحة.'}
 $commands=@(
  @('python','scripts/reconstruct_requirements.py'),
  @('python','scripts/validate_foundation.py'),
  @('python','scripts/validate_s2.py')
 )
 $combined=[Collections.Generic.List[string]]::new()
 foreach($command in $commands){
  $run=Invoke-S3Process -Context $Context -FilePath $command[0] -ArgumentList $command[1..($command.Count-1)] -WorkingDirectory $repoPath -TimeoutSeconds 900
  $combined.Add($run.StdOut);$combined.Add($run.StdErr)
 }
 $all=$combined -join "`n"
 Assert-S3RepositoryValidationOutput -Text $all
 $result=[ordered]@{repository=$script:Repo;commit=$commit;status='PASS';issue2='OPEN';reconstruction='PASS';size=63710;sha256='6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b';foundation='PASS';fr='30/30';ac='14/14';p='7/7';scenarios='14/14';s2='PASS';s2Tests='23/23'}
 $result|ConvertTo-Json|Set-Content (Join-Path $Context.Root 'reports\02-repository-gate.json') -Encoding UTF8
 return $result
}

function Invoke-S3BranchAndDraftPr {
 param([Parameter(Mandatory)]$Context)
 if($Context.Mode -eq 'Plan'){return [ordered]@{status='PLANNED';branch=$script:Branch;draftPr=$null;ci='NOT_RUN'}}
 if($Context.Mode -eq 'Simulation'){
  Set-S3MapValue -Map $Context.State.resources -Name 'branch' -Value ([ordered]@{name=$script:Branch;marker=$Context.RunId})
  Set-S3MapValue -Map $Context.State.resources -Name 'draftPr' -Value ([ordered]@{number=999;url='https://example.invalid/mock';marker=$Context.RunId})
  return [ordered]@{status='SIMULATED';branch=$script:Branch;draftPr=999;ci='SIMULATED_PASS'}
 }
 if(-not (Confirm-S3Arabic 'إنشاء فرع وDraft PR' "سيُنشأ فرع S3 واحد وDraft Pull Request واحدة فقط بعد نجاح بوابات S1 وS2.`nلن يتم الدمج أو إغلاق Issue #2.`nاختر متابعة أو إلغاء.")){
  throw 'ألغى المستخدم إنشاء الفرع وDraft PR.'
 }
 $repoPath=Join-Path $Context.Root 'repository'
 $existing=@((Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('pr','list','--repo',$script:Repo,'--head',$script:Branch,'--state','all','--json','number,state,isDraft,url') -AllowFailure).StdOut|ConvertFrom-Json)
 if($existing.Count -gt 1){throw 'أكثر من PR للفرع؛ توقف.'}
 if($existing.Count -eq 1){
  if(-not $existing[0].isDraft -or $existing[0].state -ne 'OPEN'){throw 'PR الموجودة ليست Draft مفتوحة.'}
  $view=$existing[0]
 }else{
  $branchCheck=Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('show-ref','--verify','--quiet',"refs/heads/$script:Branch") -AllowFailure
  if($branchCheck.ExitCode -eq 0){
   Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('switch',$script:Branch)|Out-Null
  }else{
   Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('switch','-c',$script:Branch)|Out-Null
  }
  $payload=Join-Path $Context.Root 'workspace\repository_payload'
  if(Test-Path $payload){Copy-Item "$payload\*" $repoPath -Recurse -Force}
  Assert-S3NoSecret -Context $Context -Path $repoPath
  Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('add','--all')|Out-Null
  $changed=(Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('status','--porcelain')).StdOut.Trim()
  if(-not $changed){throw 'لا توجد ملفات بوابة CPU لإيداعها؛ توقف لمنع PR فارغة.'}
  Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('commit','-m','S3: add mandatory CPU gate tooling')|Out-Null
  Assert-S3NoSecret -Context $Context -Path $repoPath
  Invoke-S3Process -Context $Context -FilePath 'git' -WorkingDirectory $repoPath -ArgumentList @('push','-u','origin',$script:Branch)|Out-Null
  $body="Relates to #2`n`nCPU gate tooling only. No functional S3 implementation. No cloud results are claimed."
  if($body -match '(?i)\b(closes|fixes|resolves)\s+#2'){throw 'صياغة PR قد تغلق Issue #2.'}
  $created=(Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('pr','create','--repo',$script:Repo,'--base','main','--head',$script:Branch,'--draft','--title','S3: mandatory CPU gate tooling','--body',$body)).StdOut.Trim()
  $view=(Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('pr','view',$created,'--repo',$script:Repo,'--json','number,url,isDraft,state,headRefName,baseRefName')).StdOut|ConvertFrom-Json
 }
 if(-not $view.isDraft -or $view.state -ne 'OPEN'){throw 'فشل إثبات Draft PR.'}
 $checksRun=Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('pr','checks',[string]$view.number,'--repo',$script:Repo,'--watch','--fail-fast','--interval','10') -TimeoutSeconds 1200 -AllowFailure
 if($checksRun.ExitCode -ne 0){throw "فشلت CI أو لم تكتمل: $($checksRun.StdErr)"}
 $checksJson=(Invoke-S3Process -Context $Context -FilePath 'gh' -ArgumentList @('pr','checks',[string]$view.number,'--repo',$script:Repo,'--json','name,state,bucket,link,workflow') -TimeoutSeconds 120).StdOut|ConvertFrom-Json
 if(@($checksJson).Count -eq 0 -or @($checksJson|Where-Object{$_.bucket -ne 'pass'}).Count -gt 0){throw 'تعذر إثبات نجاح جميع فحوص CI.'}
 Set-S3MapValue -Map $Context.State.resources -Name 'branch' -Value ([ordered]@{name=$script:Branch;marker=$Context.RunId})
 Set-S3MapValue -Map $Context.State.resources -Name 'draftPr' -Value ([ordered]@{number=$view.number;url=$view.url;marker=$Context.RunId})
 return [ordered]@{status='PASS';branch=$script:Branch;draftPr=$view.number;url=$view.url;ci='PASS';checks=@($checksJson)}
}
Export-ModuleMember -Function *-S3*
