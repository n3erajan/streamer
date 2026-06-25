const {execSync} = require('child_process'); console.log(execSync('yt-dlp -f "b[ext=mp4]/b" -g https://www.youtube.com/watch?v=pCh_Frmbox8', {encoding: 'utf8'}));
