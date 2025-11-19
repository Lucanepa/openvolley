#!/usr/bin/env python3
"""
PDF Form Field Hierarchy Flattener
Splits parent fields with children into separate independent fields
"""

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject, DictionaryObject, ArrayObject
import sys
import shutil

def flatten_field(field_obj, parent_name=""):
    """
    Flatten a field hierarchy into a list of independent fields
    Returns list of (full_name, field_dict) tuples
    """
    flattened = []
    
    # Get the partial name of this field
    partial_name = str(field_obj.get("/T", ""))
    full_name = f"{parent_name}.{partial_name}" if parent_name else partial_name
    
    # Check if this field has children
    if "/Kids" in field_obj:
        kids = field_obj["/Kids"]
        
        # If the children are widget annotations (have /Subtype /Widget), 
        # this is a terminal field with multiple appearances
        has_widget_kids = False
        if len(kids) > 0:
            first_kid = kids[0].get_object()
            if "/Subtype" in first_kid and first_kid["/Subtype"] == "/Widget":
                has_widget_kids = True
        
        if has_widget_kids:
            # This is a terminal field with widget annotations
            # We need to create separate fields for each widget
            for idx, kid in enumerate(kids):
                kid_obj = kid.get_object()
                
                # Create a new independent field for this widget
                new_field = DictionaryObject()
                
                # Copy all properties from parent except /Kids
                for key in field_obj.keys():
                    if key not in ["/Kids", "/T"]:
                        new_field[key] = field_obj[key]
                
                # Set the new name with suffix
                new_name = f"{full_name}#{idx}"
                new_field[NameObject("/T")] = TextStringObject(new_name)
                
                # Copy widget-specific properties from the kid
                for key in kid_obj.keys():
                    if key not in ["/Parent", "/T"]:
                        new_field[key] = kid_obj[key]
                
                flattened.append((new_name, new_field))
        else:
            # Children are sub-fields, recurse into them
            for kid in kids:
                kid_obj = kid.get_object()
                flattened.extend(flatten_field(kid_obj, full_name))
    else:
        # No children, this is already a terminal field
        flattened.append((full_name, field_obj))
    
    return flattened

def flatten_all_fields(input_pdf, output_pdf):
    """
    Flatten all hierarchical fields in the PDF
    """
    reader = PdfReader(input_pdf)
    writer = PdfWriter()
    writer.append(reader)
    
    if "/AcroForm" not in writer._root_object:
        print("No form fields found!")
        return False
    
    acro_form = writer._root_object["/AcroForm"]
    if "/Fields" not in acro_form:
        print("No fields array found!")
        return False
    
    fields_array = acro_form["/Fields"]
    original_count = len(fields_array)
    
    print(f"\nOriginal top-level fields: {original_count}")
    print("\nFlattening hierarchical fields...\n")
    
    # Collect all flattened fields
    all_flattened = []
    flattened_count = 0
    
    for idx in range(len(fields_array)):
        field_obj = fields_array[idx].get_object()
        field_name = str(field_obj.get("/T", f"Field{idx+1}"))
        
        flattened = flatten_field(field_obj)
        
        if len(flattened) > 1:
            print(f"Position {idx + 1}: '{field_name}' → {len(flattened)} separate fields")
            for name, _ in flattened:
                print(f"  - {name}")
            flattened_count += 1
        
        all_flattened.extend(flattened)
    
    if flattened_count > 0:
        # Replace the fields array with flattened fields
        new_fields_array = ArrayObject()
        for _, field_dict in all_flattened:
            new_fields_array.append(writer._add_object(field_dict))
        
        acro_form[NameObject("/Fields")] = new_fields_array
        
        # Write the result
        temp_pdf = output_pdf + ".tmp"
        with open(temp_pdf, "wb") as output_file:
            writer.write(output_file)
        shutil.move(temp_pdf, output_pdf)
        
        print(f"\n{'='*60}")
        print(f"✓ Flattened {flattened_count} hierarchical field(s)")
        print(f"✓ Total fields after flattening: {len(all_flattened)}")
        print(f"✓ File saved: {output_pdf}")
        print(f"{'='*60}")
        return True
    else:
        print("\n✗ No hierarchical fields found to flatten")
        return False

def list_all_fields_flat(input_pdf):
    """List all fields in a flattened view"""
    reader = PdfReader(input_pdf)
    
    if "/Root" not in reader.trailer or "/AcroForm" not in reader.trailer["/Root"]:
        print("No form fields found in the PDF!")
        return
    
    acro_form = reader.trailer["/Root"]["/AcroForm"]
    if "/Fields" not in acro_form:
        print("No fields array found!")
        return
    
    fields_array = acro_form["/Fields"]
    
    print(f"\nTotal top-level fields: {len(fields_array)}\n")
    print(f"{'Position':<10} {'Field Name':<60} {'Has Children':<15}")
    print("-" * 85)
    
    for idx in range(len(fields_array)):
        field_obj = fields_array[idx].get_object()
        name = str(field_obj.get("/T", f"Field{idx+1}"))
        has_kids = "Yes" if "/Kids" in field_obj else "No"
        
        # Check if kids are widgets or sub-fields
        kid_type = ""
        if has_kids == "Yes" and len(field_obj["/Kids"]) > 0:
            first_kid = field_obj["/Kids"][0].get_object()
            if "/Subtype" in first_kid and first_kid["/Subtype"] == "/Widget":
                kid_type = f" ({len(field_obj['/Kids'])} widgets)"
            else:
                kid_type = f" ({len(field_obj['/Kids'])} fields)"
        
        print(f"{idx + 1:<10} {name:<60} {has_kids + kid_type:<15}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  Flatten hierarchical fields:")
        print("    python flatten_fields.py input.pdf")
        print()
        print("  List fields and show hierarchy:")
        print("    python flatten_fields.py input.pdf --list")
        print()
        print("Examples:")
        print("  python flatten_fields.py form.pdf")
        print("  python flatten_fields.py form.pdf --list")
        print()
        print("Note: This will convert parent fields with children into separate")
        print("      independent fields (e.g., 'field' with kids becomes 'field#0', 'field#1')")
        sys.exit(1)
    
    input_file = sys.argv[1]
    
    if len(sys.argv) >= 3 and sys.argv[2] == "--list":
        list_all_fields_flat(input_file)
    else:
        flatten_all_fields(input_file, input_file)