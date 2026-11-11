const onxrloaded = () => {
  XR8.XrController.configure({
    imageTargetData: [
     require('../image-targets/Compaginado4.json'),
     require('../image-targets/Compaginado2.json'),
     require('../image-targets/Compaginado3.json'),
     require('../image-targets/Compaginado1.json'),
     require('../image-targets/Compaginado5.json'),
     require('../image-targets/Compaginado6.json'),
     require('../image-targets/Compaginado7.json')     
    ],
  })
}
window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)