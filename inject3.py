import json,os
html=open('viewer3.html',encoding='utf-8').read()
data=open('textured.json',encoding='utf-8').read().strip()
open_tag='<script id="geometry" type="application/json">'
i=html.index(open_tag)+len(open_tag)
j=html.index('</script>',i)
final=html[:i]+'\n'+data+'\n'+html[j:]
open('conker_viewer.html','w',encoding='utf-8').write(final)
print("wrote conker_viewer.html",os.path.getsize('conker_viewer.html')//1024,"KB")
d=json.loads(data)
print("textures",len(d["textures"]),"objects",len(d["objects"]),"levels",len(d["levels"]))
