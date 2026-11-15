import {BufferGeometry,Float32BufferAttribute,Mesh,Camera,Scene,RawShaderMaterial,
  Vector4,WebGLRenderTarget,type WebGLRenderer} from 'three';

// Capture Moon's already-rendered left-eye image while its XR framebuffer is valid.
export function createEyeCapture(renderer:WebGLRenderer,width:number,height:number,withTrack=true){
  const gl=renderer.getContext() as WebGL2RenderingContext;
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw new Error('Eye capture unavailable');
  const manual=typeof CanvasCaptureMediaStreamTrack!=='undefined' &&
    'requestFrame' in CanvasCaptureMediaStreamTrack.prototype;
  const track=withTrack?canvas.captureStream(manual?0:60).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack:undefined;
  if(withTrack && !track)throw new Error('No canvas video track');
  const copy=new WebGLRenderTarget(width,height,{depthBuffer:false,stencilBuffer:false});
  const material=new RawShaderMaterial({
    uniforms:{eye:{value:copy.texture}},depthTest:false,depthWrite:false,
    vertexShader:'attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}',
    fragmentShader:'precision highp float; uniform sampler2D eye; varying vec2 uv; void main(){gl_FragColor=texture2D(eye,uv);}',
  });
  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute([-1,-1,3,-1,-1,3],2));
  const triangle=new Mesh(geometry,material);triangle.frustumCulled=false;
  const scene=new Scene(),camera=new Camera();scene.add(triangle);
  const read=gl.createFramebuffer();
  const viewport=new Vector4(),scissor=new Vector4();
  let destination:WebGLFramebuffer|null=null,validated=false;
  return {
    renderer,track,width,height,canvas,
    draw(view:XRView){
      const layer=renderer.xr.getBaseLayer();
      const legacy='framebuffer' in layer;
      const sub=legacy?undefined:renderer.xr.getBinding().getViewSubImage(layer,view);
      const rect=legacy?layer.getViewport(view):sub!.viewport;
      if(!rect)return;
      let sx=rect.x,sy=gl.drawingBufferHeight-rect.y-rect.height;
      // Some runtimes render directly into the canvas. It can be cropped without a GPU copy.
      if(!legacy || layer.framebuffer!==null){
        const original=renderer.getRenderTarget();
        renderer.getViewport(viewport);renderer.getScissor(scissor);
        const clipped=renderer.getScissorTest(),autoClear=renderer.autoClear,xrEnabled=renderer.xr.enabled;
        renderer.xr.enabled=false;
        try{
          renderer.setRenderTarget(copy);
          destination??=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
          if(legacy)gl.bindFramebuffer(gl.READ_FRAMEBUFFER,layer.framebuffer);
          else{
            if(!read)throw new Error('No capture framebuffer');
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);
            // Three creates a packed 2D projection-layer texture for both eyes.
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,sub!.colorTexture,0);
          }
          try{
            if(!validated && gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)
              throw new Error('Unreadable XR image');
            gl.blitFramebuffer(rect.x,rect.y,rect.x+rect.width,rect.y+rect.height,
              0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
            if(!validated && gl.getError()!==gl.NO_ERROR)throw new Error('Eye copy unavailable');
            validated=true;
          }finally{
            if(!legacy)gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,null,0);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER,destination);
          }
          renderer.setRenderTarget(null);renderer.setScissorTest(false);renderer.setViewport(0,0,width,height);
          renderer.autoClear=false;renderer.render(scene,camera);
          sx=0;sy=gl.drawingBufferHeight-height;
          ctx.drawImage(renderer.domElement,sx,sy,width,height,0,0,width,height);
        }finally{
          renderer.autoClear=autoClear;
          renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(clipped);
          renderer.setRenderTarget(original);renderer.xr.enabled=xrEnabled;
        }
      }else ctx.drawImage(renderer.domElement,sx,sy,rect.width,rect.height,0,0,width,height);
      if(manual)track?.requestFrame();
    },
    close(){track?.stop();gl.deleteFramebuffer(read);copy.dispose();material.dispose();geometry.dispose();canvas.width=canvas.height=1;},
  };
}
