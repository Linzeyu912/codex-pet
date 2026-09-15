import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { readAtlasFrame, compareFrames } from "./lib/frame-analysis.mjs";
import { readSourceCells, isGreen, isRed, eyeMasks } from "./lib/red-penguin.mjs";
import { projectRoot } from "./lib/project-utils.mjs";
import { POSE_ACTION_INDICES } from "./lib/pose-atlas-quality.mjs";

const COUNTS = [7,8,8,4,5,8,6,6,6,8,8];
const NAMES = ["idle","right","left","wave","jump","failed","wait","work","review","look-a","look-b"];
const extract = (data, columns, index) => {
  const out = Buffer.alloc(192*208*4), row=Math.floor(index/columns), col=index%columns;
  for(let y=0;y<208;y++) data.copy(out,y*192*4,((row*208+y)*columns*192+col*192)*4,((row*208+y)*columns*192+col*192+192)*4);
  return out;
};
const metric = data => readAtlasFrame(data,{atlasWidth:192,cellWidth:192,cellHeight:208,row:0,column:0});

export async function auditAnimation(inputPath = path.join(projectRoot,"public/local/spritesheet.png"), posePath = path.join(path.dirname(inputPath),"desktop-poses.png")) {
  const errors=[],check=(condition,message)=>{if(!condition)errors.push(message)};
  const main=await sharp(inputPath).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const desktop=await sharp(posePath).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  check(main.info.width===1536&&main.info.height===2288,"Main atlas must be 1536x2288");
  check(desktop.info.width===768&&desktop.info.height===832,"Desktop atlas must be 768x832");
  if(errors.length)return {ok:false,errors};
  for(const [name,data] of [["main",main.data],["desktop",desktop.data]]) {
    let partial=0,hidden=0,chroma=0;
    for(let o=0;o<data.length;o+=4){const a=data[o+3];if(a!==0&&a!==255)partial++;if(!a&&(data[o]||data[o+1]||data[o+2]))hidden++;if(a&&isGreen(data[o],data[o+1],data[o+2]))chroma++;}
    check(!partial&&!hidden&&!chroma,`${name}: partial=${partial}, hidden RGB=${hidden}, chroma=${chroma}`);
  }
  const frames=Array.from({length:88},(_,i)=>extract(main.data,8,i)),metrics=frames.map(metric);
  const poses=Array.from({length:16},(_,i)=>extract(desktop.data,4,i)),pm=poses.map(metric);
  for(let row=0;row<11;row++)for(let col=0;col<8;col++) {
    const f=metrics[row*8+col];
    if(col>=COUNTS[row]){check(f.area===0,`Unused cell ${row}/${col} is not transparent`);continue;}
    check(f.area>0,`Empty cell ${row}/${col}`);
    check(f.left>=4&&f.right<=187&&f.top>=4&&f.baseline<=203,`Clipped cell ${row}/${col}`);
    check(!f.componentAnalysis.detached.some(c=>c.area>10&&!c.plausibleFoot),`Detached fragment ${row}/${col}`);
  }
  for(let i=0;i<16;i++) {
    const f=pm[i];check(f.area>0&&f.left>=4&&f.right<=187&&f.top>=4&&f.baseline===187,`Pose ${i} has invalid bounds or baseline`);
  }
  // Independently infer the admissible camera scale interval from every measured
  // source/output dimension. A per-frame fit or anisotropic stretch cannot pass.
  const source=await readSourceCells(path.join(projectRoot,"public/qq-penguin-source.png"));
  let scaleLow=0,scaleHigh=Infinity;
  for(let i=0;i<16;i++)for(const axis of ["width","height"]) {
    scaleLow=Math.max(scaleLow,(pm[i][axis]-1)/source[i][axis]);
    scaleHigh=Math.min(scaleHigh,(pm[i][axis]+1)/source[i][axis]);
  }
  check(scaleLow<=scaleHigh,"Poses do not share one isotropic camera scale");
  const heights=pm.slice(0,12).map(f=>f.height),heightRatio=Math.max(...heights)/Math.min(...heights);
  check(heightRatio<=1.06,`Generated standing proportions differ by ${(100*(heightRatio-1)).toFixed(2)}%, limit 6%`);
  // Same pose in both formats must be identical, including the idle anchor.
  const cross=[[0,9],[6,9],[25,8],...[0,1,2,3,4,5,6,7].map(i=>[8+i,4+i%4]),...[0,1,2,3,4,5,6,7].map(i=>[16+i,i%4])];
  for(const [mainIndex,poseIndex] of cross)check(frames[mainIndex].equals(poses[poseIndex]),`Main ${mainIndex} / desktop ${poseIndex} pixels differ`);
  const scarf=[];
  for(let i=0;i<12;i++) {
    const f=pm[i],pixels=[];
    // Limit to chest: lifted orange feet have red shaded edge pixels.
    for(let y=f.top;y<f.top+f.height*.78;y++)for(let x=f.left;x<=f.right;x++) {
      const o=(y*192+x)*4;if(isRed(...poses[i].subarray(o,o+4))&&y>f.top+f.height*.62)pixels.push([x,y]);
    }
    if(i<4) {
      check(pixels.length>=30,`Left-facing pose ${i} is missing the visible scarf tab`);
      check(pixels.every(([x])=>x>f.left+f.width*.25&&x<f.left+f.width*.7),`Left-facing pose ${i} has a misplaced scarf tab`);
    } else if(i===8||i===9) {
      check(pixels.length>=30,`Front pose ${i} is missing the scarf tab`);
      check(pixels.every(([x])=>x>f.left+f.width*.5),`Front pose ${i} has a second/wrong-side scarf tab`);
    } else check(pixels.length<=3,`Right-facing/back pose ${i} has a dangling scarf tab (${pixels.length} pixels)`);
    scarf.push({pose:i,visibleTabPixels:pixels.length});
  }
  // Pupil changes must stay inside the two white eye regions. Their centroids
  // must follow the entire clockwise direction circle, including the seam.
  const eyes=eyeMasks({data:frames[0],width:192,height:208}),mask=new Set(eyes.flatMap(e=>[...e.mask]));
  const centers=[];
  for(let i=0;i<16;i++) {
    const f=frames[72+i];let sx=0,sy=0,n=0;
    for(let p=0;p<192*208;p++) {
      if(!mask.has(p))check(f.subarray(p*4,p*4+4).equals(frames[0].subarray(p*4,p*4+4)),`Gaze ${i} changed body pixel ${p}`);
      else if(f[p*4]<100){sx+=p%192;sy+=Math.floor(p/192);n++;}
    }
    check(n>0,`Gaze ${i} has no pupils`);centers.push({x:sx/n,y:sy/n});
  }
  const cx=centers.reduce((s,c)=>s+c.x,0)/16,cy=centers.reduce((s,c)=>s+c.y,0)/16;
  const angles=centers.map((c,i)=>{const actual=Math.atan2(c.x-cx,-(c.y-cy))*180/Math.PI;return Math.abs(((actual-i*22.5+540)%360)-180)});
  check(Math.max(...angles)<=22.5,`Pupil direction error ${Math.max(...angles).toFixed(1)} degrees`);
  check(centers[4].x-centers[12].x>=3&&centers[8].y-centers[0].y>=3,"Pupil travel is too small");
  for(let i=0;i<5;i++) {
    const dy=[0,-7,-14,-7,0][i], expected=Buffer.alloc(frames[0].length);
    for(let y=0;y<208;y++){const ty=y+dy;if(ty>=0&&ty<208)frames[0].copy(expected,ty*192*4,y*192*4,(y+1)*192*4);}
    check(frames[32+i].equals(expected),`Jump ${i} changes scale instead of translating`);
  }
  check(!frames[0].equals(frames[3]),"Idle blink is missing");
  const transitions=[];
  const inspectSequence=(name,sequence,maxCenter,minIou,maxArea)=>{
    const t=sequence.slice(1).map((f,i)=>compareFrames(sequence[i],f));
    const summary={name,maxCenter:Math.max(...t.map(v=>v.center)),minIou:Math.min(...t.map(v=>v.iou)),maxArea:Math.max(...t.map(v=>v.areaRatio))};
    check(summary.maxCenter<=maxCenter&&summary.minIou>=minIou&&summary.maxArea<=maxArea,`${name} transition exceeds limits: ${JSON.stringify(summary)}`);transitions.push(summary);
  };
  for(let row=0;row<11;row++) {
    const count=row===0?6:COUNTS[row],sequence=metrics.slice(row*8,row*8+count);
    if(row<9)sequence.push(sequence[0]);
    inspectSequence(NAMES[row],sequence,row===5?32:row===3?16:15,row===5?.45:row===3?.65:.8,row===5?1.3:1.15);
  }
  for(const [name,indices] of Object.entries(POSE_ACTION_INDICES))inspectSequence(name,[metrics[0],...indices.map(i=>pm[i]),metrics[0]],32,.45,1.3);
  // Shared scale is measured above; silhouette width changes naturally with
  // the view and is not forced to have equal occupied area.
  return {ok:errors.length===0,errors:[...new Set(errors)],scale:{low:scaleLow,high:scaleHigh,standingHeights:heights,standingHeightRatio:heightRatio},scarf,pupilMaxAngleError:Math.max(...angles),crossAtlasIdenticalPairs:cross.length,transitions};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);let input,pose,report;
  for(let i=0;i<args.length;i++){if(args[i]==="--report")report=args[++i];else if(args[i]==="--pose-atlas")pose=args[++i];else if(args[i].startsWith("--"))throw new Error(`Unknown option ${args[i]}`);else input=path.resolve(args[i]);}
  const result=await auditAnimation(input,pose);console.table(result.transitions);console.log(JSON.stringify({...result,transitions:undefined},null,2));
  if(report){await fs.mkdir(path.dirname(path.resolve(report)),{recursive:true});await fs.writeFile(report,JSON.stringify(result,null,2)+"\n");}
  if(!result.ok)process.exitCode=1;
}
